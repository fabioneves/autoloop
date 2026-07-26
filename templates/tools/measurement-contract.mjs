#!/usr/bin/env node

import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fixtureRetryReceiptForMeasurement,
  OUTAGE_TRANSITIONS,
  validateRuntimePlan,
  validateRuntimeReceipt,
  validateRuntimeRun,
} from './runtime-contract.mjs';
import {
  evaluate as evaluateCommandPolicy,
  loadConfiguredBase,
} from './command-guard.mjs';

export const MEASUREMENT_VERSION = 1;
export const MEASUREMENT_EVENT_VERSION = 1;
export const BUDGET_VERSION = 1;
export const BUDGET_POLICY_VERSION = 1;
export const BUDGET_POLICY_PATH = '.autoloop/measurement-budget-policy.json';
export const MEASUREMENT_EVIDENCE_BUNDLE_VERSION = 1;
export const MEASUREMENT_EVIDENCE_BUNDLE_PATH =
  '.autoloop/measurement-evidence-v1.json';

const HOSTS = new Set(['claude', 'codex', 'opencode']);
const SELECTORS = new Set(['native', ...HOSTS]);
const ROUTE_CATALOG = Object.freeze({
  'claude.native': { activeHost: 'claude', requestedEngine: 'claude' },
  'codex.native': { activeHost: 'codex', requestedEngine: 'codex' },
  'opencode.native': { activeHost: 'opencode', requestedEngine: 'opencode' },
  'claude.codex-exec': { activeHost: 'claude', requestedEngine: 'codex' },
  'claude.opencode-exec': { activeHost: 'claude', requestedEngine: 'opencode' },
});
const ROUTES = new Set(Object.keys(ROUTE_CATALOG));
const LANES = new Set(['docs', 'small', 'full']);
const STAGES = new Set([
  'premise',
  'selection',
  'planning',
  'plan-review',
  'claim',
  'implementation',
  'simplify',
  'diff-review',
  'code-review',
  'judgment-review',
  'recovery',
  'gate',
  'delivery',
]);
const DISPATCH_STAGES = new Set([
  'plan-review',
  'implementation',
  'code-review',
  'judgment-review',
]);
const ROLES = new Set(['writer', 'reviewer', 'orchestrator']);
const CHECKPOINTS = new Set(['legacy-workflow', 'safe-system', 'post-optimization']);
const FLOWS = new Set(['dev', 'pitcrew']);
const MERGE_POLICIES = new Set(['manual', 'ratified', 'auto']);
const BASE_STRATEGIES = new Set(['manual', 'direct-strict', 'merge-queue']);
const INTENT_SOURCES = new Set(['invocation', 'relaunch', 'orphan-recovery']);
const INTENT_PROVENANCE = 'best-effort-unverified';
const RESUME_KINDS = new Set(['fresh', 'resumed', 'restarted']);
const RECOVERY_KINDS = new Set(['not-needed', 'resumed', 'reconciled', 'blocked']);
const GATE_RESULTS = new Set(['first-pass', 'after-retry', 'failed', 'not-run']);
const TERMINAL_STATUSES = new Set(['completed', 'blocked', 'failed']);
const AVOIDED_METHODS = new Set([
  'matched-control',
  'non-mutating-replay',
  'labeled-counterfactual',
]);
const AVOIDED_UNITS = new Set([
  'milliseconds',
  'github-api-requests',
  'subprocesses',
  'remote-mutations',
]);
const SHA_RE = /^[0-9a-f]{40}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9:_/-]{0,79}$/;
const FINDING_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const RECORD_KEYS = [
  'version',
  'recordId',
  'capturedAt',
  'revision',
  'workload',
  'checkpoint',
  'comparisonContextFingerprint',
  'checkpointEndpointFingerprint',
  'activeHost',
  'selector',
  'requestedEngine',
  'requestedRoute',
  'intentProvenance',
  'intent',
  'lane',
  'mergePolicy',
  'baseFreshnessStrategy',
  'configFingerprint',
  'capabilityFingerprint',
  'outageFingerprint',
  'outageTransition',
  'instrumentationOverhead',
  'segments',
  'unit',
  'observation',
];
const OBSERVATION_KEYS = [
  'runId',
  'unitId',
  'runtimeRunFingerprint',
  'terminalEvidenceFingerprint',
];
const PROVENANCE_KEYS = [
  'kind',
  'storeId',
  'authenticatedAt',
  'contentFingerprint',
  'observationFingerprint',
  'capture',
  'mac',
];
const CAPTURE_KEYS = ['revisionSource', 'timeSource', 'checkpointSource', 'observationSource'];
const INTENT_KEYS = ['flow', 'source'];
const OVERHEAD_KEYS = ['durationMs', 'githubApi', 'subprocesses', 'remoteMutations'];
const SEGMENT_KEYS = [
  'id',
  'stage',
  'round',
  'role',
  'effectiveLane',
  'laneProofFingerprint',
  'requestedRoute',
  'actualRoute',
  'adapter',
  'degradation',
  'timing',
  'telemetry',
];
const TIMING_KEYS = [
  'timeToFirstSelectionMs',
  'totalMs',
  'activeMs',
  'engineWaitMs',
  'ciWaitMs',
  'humanWaitMs',
  'steps',
];
const SEGMENT_TIMING_KEYS = TIMING_KEYS.filter((key) => key !== 'timeToFirstSelectionMs');
const SEGMENT_TELEMETRY_KEYS = [
  'provider',
  'model',
  'engine',
  'promptTokens',
  'cachedInputTokens',
  'outputTokens',
  'reasoningTokens',
  'contextBytes',
  'costUsd',
];
const UNIT_TELEMETRY_KEYS = SEGMENT_TELEMETRY_KEYS.slice(3);
const UNIT_TELEMETRY = new Set(UNIT_TELEMETRY_KEYS);
const UNIT_TOTAL_PROVENANCE_KEYS = [
  'method',
  'evidenceFingerprint',
  'rawEvidence',
];
const UNIT_TOTAL_EVIDENCE_KEYS = [
  'version',
  'runId',
  'unitId',
  'metric',
  'provider',
  'value',
];
const UNIT_KEYS = ['timing', 'telemetry', 'calls', 'dispatch', 'outcomes'];
const CALL_KEYS = ['githubApi', 'subprocesses', 'remoteMutations'];
const DISPATCH_KEYS = ['count', 'durationMs', 'reviewRounds', 'findings', 'rebuts'];
const FINDING_KEYS = ['critical', 'major', 'minor'];
const REBUT_KEYS = ['accepted', 'rejected'];
const OUTCOME_KEYS = [
  'terminal',
  'gate',
  'recovery',
  'overlap',
  'laneEffectiveness',
  'avoidedRework',
];
const TERMINAL_KEYS = ['status', 'stage', 'reason'];
const GATE_KEYS = ['result', 'localGreenCiRed'];
const RECOVERY_KEYS = ['resumeKind', 'recoveryKind', 'contextParks'];
const OVERLAP_KEYS = ['stagedAheadUnits', 'utilizedUnits', 'avoidedIdleWait'];
const LANE_EFFECT_KEYS = [
  'falseClassifications',
  'scopeDriftFallbacks',
  'avoidedEngineTime',
];
const AVOIDED_REWORK_KEYS = [
  'partialClaimsResumed',
  'auditRecordsBackfilled',
  'duplicateScansAvoided',
  'falseDoctorFailuresPrevented',
  'avoidedTime',
];
const AVOIDED_CLAIM_KEYS = [
  'status',
  'value',
  'unit',
  'method',
  'evidence',
];
const UNAVAILABLE_CLAIM_KEYS = ['status', 'reason'];
const AVOIDED_EVIDENCE_KEYS = [
  'fingerprint',
  'observedValue',
  'counterfactualValue',
  'controlRecords',
];
const CONTROL_RECORD_KEYS = ['recordId', 'contentFingerprint'];
const MODE_KEYS = [
  'activeHost',
  'selector',
  'requestedEngine',
  'requestedRoute',
  'intentProvenance',
  'actualRoutes',
  'lane',
  'mergePolicy',
  'baseFreshnessStrategy',
];
const BUDGET_KEYS = [
  'version',
  'budgetId',
  'createdAt',
  'workload',
  'mode',
  'source',
  'floors',
  'limits',
];
const BUDGET_SOURCE_KEYS = [
  'checkpoint',
  'revision',
  'cohortFingerprint',
  'records',
  'evidence',
];
const SOURCE_RECORD_KEYS = ['recordId', 'contentFingerprint', 'provenanceMac'];
const BUDGET_FLOOR_KEYS = ['median', 'p95', 'stable'];
const BUDGET_METRICS = Object.freeze({
  promptTokens: { path: 'unit.telemetry.promptTokens', statistic: 'median' },
  contextBytes: { path: 'unit.telemetry.contextBytes', statistic: 'median' },
  githubApiRequests: { path: 'unit.calls.githubApi', statistic: 'median' },
  subprocesses: { path: 'unit.calls.subprocesses', statistic: 'median' },
  remoteMutations: { path: 'unit.calls.remoteMutations', statistic: 'median' },
  timeToFirstSelectionMs: { path: 'unit.timing.timeToFirstSelectionMs', statistic: 'median' },
  unitTimeP50Ms: { path: 'unit.timing.totalMs', statistic: 'median' },
  unitTimeP95Ms: { path: 'unit.timing.totalMs', statistic: 'p95' },
});
const BUDGET_METRIC_KEYS = Object.keys(BUDGET_METRICS);
const EVIDENCE_KEYS = ['statistic', 'value', 'sampleCount'];
const BUDGET_POLICY_KEYS = ['version', 'status', 'reason', 'evidenceBundle', 'budgets'];
const BUDGET_POLICY_ENTRY_KEYS = ['budget', 'baselineRecordIds', 'currentRecordIds'];
const BUDGET_POLICY_EVIDENCE_KEYS = ['path', 'sha256'];
const BUDGET_POLICY_STATUSES = new Set(['pending-evidence', 'active']);
const EVENT_INPUT_KEYS = ['version', 'runId', 'kind', 'payload'];
const EVENT_RECORD_KEYS = [
  'version',
  'eventId',
  'runId',
  'sequence',
  'capturedAt',
  'revision',
  'kind',
  'payload',
  'provenance',
];
const EVENT_PROVENANCE_KEYS = [
  'kind',
  'storeId',
  'contentFingerprint',
  'capture',
  'mac',
];
const EVENT_CAPTURE_KEYS = [
  'revisionSource',
  'timeSource',
  'payloadSource',
  'durationMs',
];
const EVENT_PAYLOAD_SOURCES = new Set([
  'run-boundary-declared',
  'unavailable-evidence-declared',
  'runtime-authority-verified',
  'command-wrapper-observed',
  'gate-command-observed',
  'delivery-live-observed',
  'lifecycle-contract-verified',
  'producer-contract-verified',
]);
const EVENT_KINDS = new Set([
  'run-start',
  'unit-context',
  'stage-start',
  'wait-start',
  'wait-end',
  'operation',
  'dispatch',
  'stage-end',
  'lifecycle',
  'run-finish',
]);
const RUN_START_KEYS = [
  'workload',
  'checkpoint',
  'comparisonContextFingerprint',
  'checkpointEndpointFingerprint',
  'activeHost',
  'selector',
  'requestedEngine',
  'requestedRoute',
  'intentProvenance',
  'intent',
  'mergePolicy',
  'baseFreshnessStrategy',
  'configFingerprint',
  'runtimeBinding',
];
const UNIT_CONTEXT_KEYS = [
  'unitId',
  'initialLane',
  'initialLaneProofFingerprint',
  'planFingerprint',
  'capabilityFingerprint',
  'outageFingerprint',
];
const STAGE_START_KEYS = ['id', 'stage', 'round'];
const STAGE_END_KEYS = [
  'stageId',
  'actualRoute',
  'adapter',
  'degradation',
  'telemetry',
  'providerEvidence',
];
const WAIT_EVENT_KEYS = ['stageId', 'waitId', 'category'];
const WAIT_CATEGORIES = new Set(['engine', 'ci', 'human']);
const OPERATION_KEYS = ['stageId', 'operationId', 'kind', 'action', 'evidence'];
const OPERATION_KINDS = new Set(['github-api', 'subprocess', 'remote-mutation']);
const MEASURED_OPERATION_INPUT_KEYS = [
  'version',
  'runId',
  'stageId',
  'operationId',
  'kind',
  'action',
  'command',
];
const MEASURED_COMMAND_KEYS = ['executable', 'args', 'cwd'];
const RUNTIME_MEASUREMENT_BINDING_KEYS = [
  'run',
  'measurement',
];
const RUNTIME_MEASUREMENT_UNIT_BINDING_KEYS = [
  'runId',
  'run',
  'plan',
  'unitId',
];
const RUNTIME_MEASUREMENT_DECLARATION_KEYS = [
  'version',
  'runId',
  'workload',
  'checkpoint',
  'comparisonContextFingerprint',
  'checkpointEndpointFingerprint',
  'intentSource',
  'intentProvenance',
  'mergePolicy',
  'baseFreshnessStrategy',
];
const COMMAND_RESULT_KEYS = [
  'version',
  'operationKind',
  'status',
  'executableFingerprint',
  'argumentsFingerprint',
  'cwdFingerprint',
  'startedAt',
  'finishedAt',
  'durationMs',
  'exitCode',
  'signal',
  'stdout',
  'stderr',
];
const COMMAND_STREAM_KEYS = ['bytes', 'sha256'];
const OPERATION_INTENT_KEYS = [
  'version',
  'state',
  'runId',
  'stageId',
  'operationId',
  'inputFingerprint',
  'effectFingerprint',
  'preparedAt',
  'mac',
];
const OPERATION_COMMIT_KEYS = [
  'version',
  'state',
  'runId',
  'operationId',
  'inputFingerprint',
  'effectFingerprint',
  'eventFingerprint',
  'committedAt',
  'mac',
];
const OPERATION_INTENT_FILE_RE = /^intent-([0-9a-f]{64})\.json$/;
const OPERATION_COMMIT_FILE_RE = /^commit-([0-9a-f]{64})\.json$/;
const COMMAND_RESULT_STATUSES = new Set(['exited', 'signaled', 'launch-failed']);
const MAX_COMMAND_ARGS = 256;
const MAX_COMMAND_ARG_BYTES = 64 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const DISPATCH_EVENT_KEYS = [
  'stageId',
  'dispatchId',
  'runtimeReceipt',
  'findings',
  'rebuts',
];
const RAW_FINDING_KEYS = ['id', 'severity'];
const RAW_REBUT_KEYS = ['findingId', 'disposition'];
const FINDING_SEVERITIES = new Set(['critical', 'major', 'minor']);
const REBUT_DISPOSITIONS = new Set(['accepted', 'rejected']);
const LIFECYCLE_EVENT_KEYS = ['kind', 'subjectId', 'evidence'];
const LIFECYCLE_EVENT_KINDS = new Set([
  'context-park',
  'staged-ahead',
  'utilized-staged-unit',
  'false-lane-classification',
  'scope-drift-fallback',
  'partial-claim-resumed',
  'audit-record-backfilled',
  'duplicate-scan-avoided',
  'false-doctor-failure-prevented',
]);
const RUN_FINISH_KEYS = [
  'terminal',
  'gate',
  'recovery',
  'terminalEvidence',
  'gateEvidence',
  'lifecycleEvidence',
];
const EVIDENCE_REFERENCE_OBSERVED_KEYS = ['status', 'fingerprint', 'envelope'];
const EVIDENCE_REFERENCE_UNAVAILABLE_KEYS = ['status', 'reason'];
const TYPED_ENVELOPE_KEYS = [
  'version',
  'producer',
  'type',
  'runId',
  'subjectId',
  'payloadFingerprint',
  'payload',
];
const ENVELOPE_INPUT_KEYS = ['producer', 'type', 'subjectId', 'payload'];
const ENVELOPE_PRODUCERS = new Set([
  'runtime',
  'provider',
  'command-wrapper',
  'lifecycle-contract',
  'gate',
]);
const ENVELOPE_TYPES = new Set([
  'run-context',
  'runtime-receipt',
  'provider-accounting',
  'github-api-result',
  'subprocess-result',
  'remote-mutation-result',
  'lifecycle-result',
  'gate-result',
  'terminal-result',
]);
const TYPED_CAPTURE_KEYS = ['version', 'runId', 'kind', 'payload', 'envelopes'];
const TYPED_CAPTURE_ENVELOPE_KEYS = Object.freeze({
  'run-start': ['runtimeBinding'],
  'unit-context': [],
  'stage-start': [],
  'wait-start': [],
  'wait-end': [],
  operation: ['evidence'],
  dispatch: ['runtimeReceipt'],
  'stage-end': ['providerEvidence'],
  lifecycle: ['evidence'],
  'run-finish': ['terminalEvidence', 'gateEvidence', 'lifecycleEvidence'],
});
const EVIDENCE_BUNDLE_KEYS = ['version', 'kind', 'createdAt', 'records'];
const EVIDENCE_BUNDLE_RECORD_KEYS = ['record', 'events'];
const EVENT_DERIVATION_KEYS = [
  'pipelineVersion',
  'runId',
  'startRevision',
  'eventCount',
  'eventSetFingerprint',
];
const EVENT_FILE_RE = /^event-(\d{6})-([0-9a-f-]{36})\.json$/;
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_POLICY_BYTES = 1024 * 1024;
const MAX_EVIDENCE_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAX_RUN_EVENTS = 10_000;
const MAX_STORE_RECORDS = 10_000;
const MAX_DATA_DEPTH = 32;
const MAX_DATA_NODES = 100_000;
const MAX_BUNDLE_DATA_NODES = 2_000_000;
const MAX_DATA_WIDTH = MAX_STORE_RECORDS;
const MAX_RECORD_AGGREGATE_TERMS = 128;
const MAX_MEASUREMENT_NUMBER = Math.floor(
  Number.MAX_SAFE_INTEGER / (MAX_STORE_RECORDS * MAX_RECORD_AGGREGATE_TERMS),
);
const STORE_KEY_FILE = '.measurement-auth-key';
const STORE_LOCK_REF = 'refs/autoloop/measurement-store-lock';
const STORE_LOCK_TIMEOUT_MS = 15_000;
const TRUSTED_RECORDS = new WeakMap();
const DERIVED_RECORDS = new WeakMap();
const TRUSTED_DERIVED_RECORDS = new WeakSet();
const TRUSTED_EVENTS = new WeakSet();
const GIT_CONTEXT = resolve(process.cwd());

function sanitizedGitEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
}

function gitArguments(args) {
  return ['--no-replace-objects', '-C', GIT_CONTEXT, ...args];
}

function gitExec(args, options = {}) {
  return execFileSync('git', gitArguments(args), {
    encoding: 'utf8',
    env: sanitizedGitEnvironment(),
    timeout: 10_000,
    ...options,
  });
}

function gitSpawn(args, options = {}) {
  return spawnSync('git', gitArguments(args), {
    encoding: 'utf8',
    env: sanitizedGitEnvironment(),
    timeout: 10_000,
    ...options,
  });
}

function plainObject(value) {
  if (!hasPlainObjectPrototype(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(descriptors).every(
    (key) => typeof key === 'string' && !descriptors[key].get && !descriptors[key].set,
  );
}

function hasPlainObjectPrototype(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateDataGraph(
  value,
  { maximumNodes = MAX_DATA_NODES, rootPath = 'record' } = {},
) {
  const errors = [];
  const stack = [{ value, depth: 0, path: rootPath }];
  const seen = new Set();
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > maximumNodes) {
      errors.push(`${rootPath}: exceeds ${maximumNodes} data nodes`);
      break;
    }
    if (current.depth > MAX_DATA_DEPTH) {
      errors.push(`${current.path}: exceeds maximum depth ${MAX_DATA_DEPTH}`);
      continue;
    }
    if (current.value === null || typeof current.value !== 'object') continue;
    if (seen.has(current.value)) {
      errors.push(`${current.path}: cyclic or aliased objects are invalid`);
      continue;
    }
    seen.add(current.value);
    const array = Array.isArray(current.value);
    if (!array && !hasPlainObjectPrototype(current.value)) {
      errors.push(`${current.path}: expected plain JSON data`);
      continue;
    }
    if (array && current.value.length > maximumNodes) {
      errors.push(`${current.path}: array exceeds ${maximumNodes} entries`);
      continue;
    }
    let keys;
    try {
      keys = Reflect.ownKeys(current.value);
    } catch {
      errors.push(`${current.path}: property inspection failed`);
      continue;
    }
    const width = keys.length - (array ? 1 : 0);
    if (width > MAX_DATA_WIDTH) {
      errors.push(
        `${current.path}: exceeds ${MAX_DATA_WIDTH} own properties`,
      );
      continue;
    }
    for (const key of keys) {
      if (key === 'length') continue;
      if (typeof key !== 'string') {
        errors.push(`${current.path}: symbol properties are invalid`);
        continue;
      }
      let descriptor;
      try {
        descriptor = Object.getOwnPropertyDescriptor(current.value, key);
      } catch {
        errors.push(`${current.path}.${key}: property inspection failed`);
        continue;
      }
      if (!descriptor) {
        errors.push(`${current.path}.${key}: property disappeared during inspection`);
        continue;
      }
      if (descriptor.get || descriptor.set) {
        errors.push(`${current.path}.${key}: accessors are invalid`);
        continue;
      }
      stack.push({
        value: descriptor.value,
        depth: current.depth + 1,
        path: `${current.path}.${key}`,
      });
    }
  }
  return { ok: errors.length === 0, errors };
}

function exactObject(errors, path, value, keys, optional = []) {
  if (!plainObject(value)) {
    errors.push(`${path}: expected a plain data object`);
    return false;
  }
  const allowed = new Set([...keys, ...optional]);
  const actual = Object.keys(value);
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: required`);
  }
  for (const key of actual) {
    if (!allowed.has(key)) errors.push(`${path}.${key}: unknown field`);
  }
  return true;
}

function denseArray(errors, path, value, minimum = 0, maximum = 10_000) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    errors.push(`${path}: expected an array`);
    return false;
  }
  if (value.length < minimum || value.length > maximum) {
    errors.push(`${path}: expected ${minimum}..${maximum} entries`);
    return false;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (
      typeof key !== 'string'
      || (key !== 'length' && !/^(0|[1-9]\d*)$/.test(key))
      || descriptors[key].get
      || descriptors[key].set
    ) {
      errors.push(`${path}: array contains non-data or named properties`);
      return false;
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) errors.push(`${path}[${index}]: sparse arrays are invalid`);
  }
  return true;
}

function finiteNumber(value) {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
    && value <= MAX_MEASUREMENT_NUMBER;
}

function integer(value) {
  return Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_MEASUREMENT_NUMBER;
}

function canonicalTimestamp(value) {
  if (!ISO_RE.test(value ?? '')) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function requireEnum(errors, path, value, values) {
  if (!values.has(value)) errors.push(`${path}: unsupported value ${JSON.stringify(value)}`);
}

function requireString(errors, path, value, maximum = 500) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    errors.push(`${path}: expected a non-empty string no longer than ${maximum} characters`);
  }
}

function requireNumber(errors, path, value, integerOnly = false) {
  if (!(integerOnly ? integer(value) : finiteNumber(value))) {
    errors.push(`${path}: expected a non-negative ${integerOnly ? 'integer' : 'number'}`);
  }
}

function validateProviderUnitTotalEvidence(errors, path, value, context, claimedValue) {
  if (!exactObject(errors, path, value, UNIT_TOTAL_EVIDENCE_KEYS)) return;
  if (value.version !== 1) errors.push(`${path}.version: expected 1`);
  if (!UUID_RE.test(value.runId ?? '')) errors.push(`${path}.runId: expected UUID v4`);
  if (!NAME_RE.test(value.unitId ?? '')) errors.push(`${path}.unitId: invalid unit identifier`);
  requireEnum(errors, `${path}.metric`, value.metric, UNIT_TELEMETRY);
  requireString(errors, `${path}.provider`, value.provider, 200);
  requireNumber(errors, `${path}.value`, value.value, context.metric !== 'costUsd');
  if (value.runId !== context.recordValue.observation?.runId) {
    errors.push(`${path}.runId: must equal observation.runId`);
  }
  if (value.unitId !== context.recordValue.observation?.unitId) {
    errors.push(`${path}.unitId: must equal observation.unitId`);
  }
  if (value.metric !== context.metric) {
    errors.push(`${path}.metric: must equal ${context.metric}`);
  }
  if (value.value !== claimedValue) {
    errors.push(`${path}.value: must equal the claimed unit value`);
  }
  const segmentProviders = (Array.isArray(context.recordValue.segments)
    ? context.recordValue.segments
    : []).map(
    (segment) => observationValue(segment?.telemetry?.provider),
  );
  if (
    segmentProviders.some((provider) => provider === null)
    || segmentProviders.some((provider) => provider !== value.provider)
  ) {
    errors.push(`${path}.provider: must equal every observed segment provider`);
  }
}

function validateProviderUnitTotalProvenance(errors, path, value, context, claimedValue) {
  if (!exactObject(errors, path, value, UNIT_TOTAL_PROVENANCE_KEYS)) return;
  if (value.method !== 'provider-unit-total') {
    errors.push(`${path}.method: expected provider-unit-total`);
  }
  if (!HASH_RE.test(value.evidenceFingerprint ?? '')) {
    errors.push(`${path}.evidenceFingerprint: expected sha256`);
  }
  validateProviderUnitTotalEvidence(
    errors,
    `${path}.rawEvidence`,
    value.rawEvidence,
    context,
    claimedValue,
  );
  if (
    plainObject(value.rawEvidence)
    && HASH_RE.test(value.evidenceFingerprint ?? '')
    && fingerprint(value.rawEvidence) !== value.evidenceFingerprint
  ) {
    errors.push(`${path}.evidenceFingerprint: does not match rawEvidence`);
  }
}

function validateObservation(errors, path, value, type, providerUnitTotal = null) {
  if (!plainObject(value) || !['observed', 'unavailable'].includes(value.status)) {
    errors.push(`${path}: expected a typed observed or unavailable value`);
    return;
  }
  if (value.status === 'observed') {
    const hasProvenance = providerUnitTotal !== null && value.provenance !== undefined;
    const keys = ['status', 'value', ...(hasProvenance ? ['provenance'] : [])];
    if (!exactObject(errors, path, value, keys)) return;
    if (type === 'string') requireString(errors, `${path}.value`, value.value, 200);
    if (type === 'integer') requireNumber(errors, `${path}.value`, value.value, true);
    if (type === 'number') requireNumber(errors, `${path}.value`, value.value);
    if (hasProvenance) {
      validateProviderUnitTotalProvenance(
        errors,
        `${path}.provenance`,
        value.provenance,
        providerUnitTotal,
        value.value,
      );
    }
    return;
  }
  if (!exactObject(errors, path, value, ['status', 'reason'])) return;
  requireString(errors, `${path}.reason`, value.reason);
}

function observationValue(value) {
  return value?.status === 'observed' ? value.value : null;
}

function validateSteps(errors, path, value) {
  if (!exactObject(errors, path, value, [], Object.keys(value ?? {}))) return;
  const entries = Object.entries(value);
  if (entries.length > 128) errors.push(`${path}: at most 128 steps are allowed`);
  for (const [name, duration] of entries) {
    if (!NAME_RE.test(name)) errors.push(`${path}.${name}: invalid step name`);
    requireNumber(errors, `${path}.${name}`, duration);
  }
}

function validateTiming(errors, path, value, segment = false) {
  const keys = segment ? SEGMENT_TIMING_KEYS : TIMING_KEYS;
  if (!exactObject(errors, path, value, keys)) return;
  for (const key of keys.filter((candidate) => candidate !== 'steps')) {
    requireNumber(errors, `${path}.${key}`, value[key]);
  }
  validateSteps(errors, `${path}.steps`, value.steps);
  const components = ['activeMs', 'engineWaitMs', 'ciWaitMs', 'humanWaitMs'];
  if (
    components.every((key) => finiteNumber(value[key]))
    && finiteNumber(value.totalMs)
    && components.reduce((sum, key) => sum + value[key], 0) !== value.totalMs
  ) {
    errors.push(`${path}: active and wait components must equal totalMs`);
  }
  if (
    plainObject(value.steps)
    && finiteNumber(value.totalMs)
    && Object.values(value.steps).filter(finiteNumber).reduce((sum, duration) => sum + duration, 0)
      > value.totalMs
  ) errors.push(`${path}.steps: step durations cannot exceed totalMs`);
}

function validateTelemetry(errors, path, value, segment = false, recordValue = null) {
  const keys = segment ? SEGMENT_TELEMETRY_KEYS : UNIT_TELEMETRY_KEYS;
  if (!exactObject(errors, path, value, keys)) return;
  if (segment) {
    for (const key of ['provider', 'model', 'engine']) {
      validateObservation(errors, `${path}.${key}`, value[key], 'string');
    }
  }
  for (const key of ['promptTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens']) {
    validateObservation(
      errors,
      `${path}.${key}`,
      value[key],
      'integer',
      segment ? null : { recordValue, metric: key },
    );
  }
  validateObservation(
    errors,
    `${path}.contextBytes`,
    value.contextBytes,
    'integer',
    segment ? null : { recordValue, metric: 'contextBytes' },
  );
  validateObservation(
    errors,
    `${path}.costUsd`,
    value.costUsd,
    'number',
    segment ? null : { recordValue, metric: 'costUsd' },
  );
}

function expectedRequestedRoute(activeHost, requestedEngine) {
  if (activeHost === requestedEngine) return `${activeHost}.native`;
  if (activeHost === 'claude' && requestedEngine === 'codex') return 'claude.codex-exec';
  if (activeHost === 'claude' && requestedEngine === 'opencode') {
    return 'claude.opencode-exec';
  }
  return null;
}

function nativeRoute(activeHost) {
  return `${activeHost}.native`;
}

function expectedRole(stage) {
  if (stage === 'implementation') return 'writer';
  if (['plan-review', 'code-review', 'judgment-review'].includes(stage)) return 'reviewer';
  return 'orchestrator';
}

function expectedSegmentRoute(recordValue, segment) {
  const native = nativeRoute(recordValue.activeHost);
  const lane = segment.effectiveLane;
  if (
    [
      'premise',
      'selection',
      'planning',
      'claim',
      'simplify',
      'diff-review',
      'judgment-review',
      'recovery',
      'gate',
      'delivery',
    ].includes(segment.stage)
  ) return native;
  if (recordValue.intent?.flow === 'pitcrew') {
    if (segment.stage === 'plan-review') return null;
    if (segment.stage === 'code-review' && segment.round >= 2) return native;
    return recordValue.requestedRoute;
  }
  if (segment.stage === 'plan-review') {
    return lane === 'full' ? recordValue.requestedRoute : native;
  }
  if (segment.stage === 'implementation') {
    return lane === 'docs' ? native : recordValue.requestedRoute;
  }
  if (segment.stage === 'code-review') {
    if (segment.round >= 2 || lane !== 'full') return native;
    return recordValue.requestedRoute;
  }
  return null;
}

function validateDegradation(errors, path, value) {
  if (value === null) return;
  if (!exactObject(errors, path, value, ['code', 'reason'])) return;
  requireString(errors, `${path}.code`, value.code, 80);
  requireString(errors, `${path}.reason`, value.reason);
}

function validateSegment(errors, recordValue, segment, index) {
  const path = `segments[${index}]`;
  if (!exactObject(errors, path, segment, SEGMENT_KEYS)) return;
  if (!NAME_RE.test(segment.id ?? '')) errors.push(`${path}.id: invalid segment identifier`);
  requireEnum(errors, `${path}.stage`, segment.stage, STAGES);
  if (!Number.isInteger(segment.round) || segment.round < 1) {
    errors.push(`${path}.round: expected a positive integer`);
  }
  requireEnum(errors, `${path}.role`, segment.role, ROLES);
  requireEnum(errors, `${path}.effectiveLane`, segment.effectiveLane, LANES);
  if (!HASH_RE.test(segment.laneProofFingerprint ?? '')) {
    errors.push(`${path}.laneProofFingerprint: expected sha256`);
  }
  requireEnum(errors, `${path}.requestedRoute`, segment.requestedRoute, ROUTES);
  requireEnum(errors, `${path}.actualRoute`, segment.actualRoute, ROUTES);
  requireEnum(errors, `${path}.adapter`, segment.adapter, ROUTES);
  validateDegradation(errors, `${path}.degradation`, segment.degradation);
  validateTiming(errors, `${path}.timing`, segment.timing, true);
  validateTelemetry(errors, `${path}.telemetry`, segment.telemetry, true);

  if (STAGES.has(segment.stage) && segment.role !== expectedRole(segment.stage)) {
    errors.push(`${path}.role: expected ${expectedRole(segment.stage)} for ${segment.stage}`);
  }
  if (segment.stage !== 'code-review' && segment.round !== 1) {
    errors.push(`${path}.round: only code-review may use rounds after 1`);
  }
  const expected = expectedSegmentRoute(recordValue, segment);
  if (expected === null) {
    errors.push(`${path}.stage: unsupported for ${recordValue.intent.flow}`);
  } else if (segment.requestedRoute !== expected) {
    errors.push(`${path}.requestedRoute: expected ${expected} for this stage and lane`);
  }
  if (ROUTES.has(segment.actualRoute)) {
    const route = ROUTE_CATALOG[segment.actualRoute];
    if (route.activeHost !== recordValue.activeHost) {
      errors.push(`${path}.actualRoute: route belongs to a different active host`);
    }
  }
  if (segment.adapter !== segment.actualRoute) {
    errors.push(`${path}.adapter: must equal actualRoute`);
  }
  if (segment.actualRoute !== segment.requestedRoute) {
    const safeWriterFallback =
      segment.stage === 'implementation'
      && segment.requestedRoute === recordValue.requestedRoute
      && segment.actualRoute === nativeRoute(recordValue.activeHost)
      && recordValue.requestedRoute !== nativeRoute(recordValue.activeHost);
    if (!safeWriterFallback) {
      errors.push(`${path}.actualRoute: unsupported route fallback`);
    }
    if (segment.degradation === null) {
      errors.push(`${path}.degradation: required when actualRoute differs`);
    }
  }
}

function validateAvoidedClaim(errors, path, value, requiredUnit) {
  if (!plainObject(value)) {
    errors.push(`${path}: expected verified evidence or typed unavailable`);
    return;
  }
  if (value.status === 'unavailable') {
    if (!exactObject(errors, path, value, UNAVAILABLE_CLAIM_KEYS)) return;
    requireString(errors, `${path}.reason`, value.reason);
    return;
  }
  if (value.status !== 'verified') {
    errors.push(`${path}.status: expected verified or unavailable`);
    return;
  }
  if (!exactObject(errors, path, value, AVOIDED_CLAIM_KEYS)) return;
  requireNumber(errors, `${path}.value`, value.value);
  requireEnum(errors, `${path}.unit`, value.unit, AVOIDED_UNITS);
  if (value.unit !== requiredUnit) errors.push(`${path}.unit: expected ${requiredUnit}`);
  requireEnum(errors, `${path}.method`, value.method, AVOIDED_METHODS);
  if (value.method !== 'matched-control') {
    errors.push(
      `${path}.method: ${value.method} requires external attestation integration; use unavailable`,
    );
  }
  if (!exactObject(errors, `${path}.evidence`, value.evidence, AVOIDED_EVIDENCE_KEYS)) return;
  requireNumber(errors, `${path}.evidence.observedValue`, value.evidence.observedValue);
  requireNumber(errors, `${path}.evidence.counterfactualValue`, value.evidence.counterfactualValue);
  if (
    finiteNumber(value.value)
    && finiteNumber(value.evidence.observedValue)
    && finiteNumber(value.evidence.counterfactualValue)
    && value.value !== Math.max(
      0,
      value.evidence.counterfactualValue - value.evidence.observedValue,
    )
  ) {
    errors.push(`${path}.value: must equal max(0, counterfactualValue - observedValue)`);
  }
  if (!HASH_RE.test(value.evidence.fingerprint ?? '')) {
    errors.push(`${path}.evidence.fingerprint: expected sha256`);
  } else {
    const expected = fingerprint({
      method: value.method,
      unit: value.unit,
      observedValue: value.evidence.observedValue,
      counterfactualValue: value.evidence.counterfactualValue,
      controlRecords: value.evidence.controlRecords,
    });
    if (value.evidence.fingerprint !== expected) {
      errors.push(`${path}.evidence.fingerprint: does not match the evidence bundle`);
    }
  }
  if (denseArray(errors, `${path}.evidence.controlRecords`, value.evidence.controlRecords, 0, 100)) {
    const seen = new Set();
    for (const [index, control] of value.evidence.controlRecords.entries()) {
      const controlPath = `${path}.evidence.controlRecords[${index}]`;
      if (!exactObject(errors, controlPath, control, CONTROL_RECORD_KEYS)) continue;
      if (!UUID_RE.test(control.recordId ?? '')) {
        errors.push(`${controlPath}.recordId: expected a lowercase UUID v4`);
      }
      if (!HASH_RE.test(control.contentFingerprint ?? '')) {
        errors.push(`${controlPath}.contentFingerprint: expected sha256`);
      }
      if (seen.has(control.recordId)) {
        errors.push(`${path}.evidence.controlRecords: duplicate ${control.recordId}`);
      }
      seen.add(control.recordId);
    }
    if (value.method === 'matched-control' && value.evidence.controlRecords.length === 0) {
      errors.push(`${path}.evidence.controlRecords: matched-control requires a control`);
    }
  }
}

function validateOutcomes(errors, value) {
  if (!exactObject(errors, 'unit.outcomes', value, OUTCOME_KEYS)) return;
  if (exactObject(errors, 'unit.outcomes.terminal', value.terminal, TERMINAL_KEYS)) {
    requireEnum(errors, 'unit.outcomes.terminal.status', value.terminal.status, TERMINAL_STATUSES);
    requireEnum(errors, 'unit.outcomes.terminal.stage', value.terminal.stage, STAGES);
    if (value.terminal.reason !== null) {
      requireString(errors, 'unit.outcomes.terminal.reason', value.terminal.reason);
    }
    if (value.terminal.status === 'completed' && value.terminal.reason !== null) {
      errors.push('unit.outcomes.terminal.reason: completed units require null');
    }
    if (value.terminal.status !== 'completed' && value.terminal.reason === null) {
      errors.push('unit.outcomes.terminal.reason: blocked and failed units require a reason');
    }
  }
  if (exactObject(errors, 'unit.outcomes.gate', value.gate, GATE_KEYS)) {
    requireEnum(errors, 'unit.outcomes.gate.result', value.gate.result, GATE_RESULTS);
    if (typeof value.gate.localGreenCiRed !== 'boolean') {
      errors.push('unit.outcomes.gate.localGreenCiRed: expected boolean');
    }
    if (value.gate.result === 'not-run' && value.gate.localGreenCiRed === true) {
      errors.push('unit.outcomes.gate.localGreenCiRed: gate not-run cannot be CI-red');
    }
  }
  if (exactObject(errors, 'unit.outcomes.recovery', value.recovery, RECOVERY_KEYS)) {
    requireEnum(errors, 'unit.outcomes.recovery.resumeKind', value.recovery.resumeKind, RESUME_KINDS);
    requireEnum(
      errors,
      'unit.outcomes.recovery.recoveryKind',
      value.recovery.recoveryKind,
      RECOVERY_KINDS,
    );
    requireNumber(errors, 'unit.outcomes.recovery.contextParks', value.recovery.contextParks, true);
  }
  if (exactObject(errors, 'unit.outcomes.overlap', value.overlap, OVERLAP_KEYS)) {
    requireNumber(
      errors,
      'unit.outcomes.overlap.stagedAheadUnits',
      value.overlap.stagedAheadUnits,
      true,
    );
    requireNumber(
      errors,
      'unit.outcomes.overlap.utilizedUnits',
      value.overlap.utilizedUnits,
      true,
    );
    if (
      integer(value.overlap.stagedAheadUnits)
      && integer(value.overlap.utilizedUnits)
      && value.overlap.utilizedUnits > value.overlap.stagedAheadUnits
    ) {
      errors.push('unit.outcomes.overlap.utilizedUnits: cannot exceed stagedAheadUnits');
    }
    validateAvoidedClaim(
      errors,
      'unit.outcomes.overlap.avoidedIdleWait',
      value.overlap.avoidedIdleWait,
      'milliseconds',
    );
  }
  if (
    exactObject(
      errors,
      'unit.outcomes.laneEffectiveness',
      value.laneEffectiveness,
      LANE_EFFECT_KEYS,
    )
  ) {
    requireNumber(
      errors,
      'unit.outcomes.laneEffectiveness.falseClassifications',
      value.laneEffectiveness.falseClassifications,
      true,
    );
    requireNumber(
      errors,
      'unit.outcomes.laneEffectiveness.scopeDriftFallbacks',
      value.laneEffectiveness.scopeDriftFallbacks,
      true,
    );
    validateAvoidedClaim(
      errors,
      'unit.outcomes.laneEffectiveness.avoidedEngineTime',
      value.laneEffectiveness.avoidedEngineTime,
      'milliseconds',
    );
  }
  if (
    exactObject(
      errors,
      'unit.outcomes.avoidedRework',
      value.avoidedRework,
      AVOIDED_REWORK_KEYS,
    )
  ) {
    for (const key of AVOIDED_REWORK_KEYS.filter((candidate) => candidate !== 'avoidedTime')) {
      requireNumber(errors, `unit.outcomes.avoidedRework.${key}`, value.avoidedRework[key], true);
    }
    validateAvoidedClaim(
      errors,
      'unit.outcomes.avoidedRework.avoidedTime',
      value.avoidedRework.avoidedTime,
      'milliseconds',
    );
  }
}

function validateUnit(errors, recordValue) {
  const value = recordValue.unit;
  if (!exactObject(errors, 'unit', value, UNIT_KEYS)) return;
  validateTiming(errors, 'unit.timing', value.timing);
  validateTelemetry(errors, 'unit.telemetry', value.telemetry, false, recordValue);
  if (exactObject(errors, 'unit.calls', value.calls, CALL_KEYS)) {
    for (const key of CALL_KEYS) requireNumber(errors, `unit.calls.${key}`, value.calls[key], true);
  }
  if (exactObject(errors, 'unit.dispatch', value.dispatch, DISPATCH_KEYS)) {
    requireNumber(errors, 'unit.dispatch.count', value.dispatch.count, true);
    requireNumber(errors, 'unit.dispatch.durationMs', value.dispatch.durationMs);
    requireNumber(errors, 'unit.dispatch.reviewRounds', value.dispatch.reviewRounds, true);
    if (exactObject(errors, 'unit.dispatch.findings', value.dispatch.findings, FINDING_KEYS)) {
      for (const key of FINDING_KEYS) {
        requireNumber(errors, `unit.dispatch.findings.${key}`, value.dispatch.findings[key], true);
      }
    }
    if (exactObject(errors, 'unit.dispatch.rebuts', value.dispatch.rebuts, REBUT_KEYS)) {
      for (const key of REBUT_KEYS) {
        requireNumber(errors, `unit.dispatch.rebuts.${key}`, value.dispatch.rebuts[key], true);
      }
    }
  }
  validateOutcomes(errors, value.outcomes);

  const segments = Array.isArray(recordValue.segments) ? recordValue.segments : [];
  validateSegmentGrammar(errors, recordValue, segments);
  const dispatchSegments = segments.filter(
    (segment) => DISPATCH_STAGES.has(segment.stage),
  );
  if (
    dispatchSegments.length > 0
    && dispatchSegments[0].effectiveLane !== recordValue.lane
  ) {
    errors.push('lane: must equal the initial Runtime dispatch lane');
  }
  if (integer(value.dispatch?.count) && value.dispatch.count !== dispatchSegments.length) {
    errors.push(`unit.dispatch.count: expected ${dispatchSegments.length} from segments`);
  }
  const dispatchDuration = dispatchSegments.reduce(
    (sum, segment) => sum + (finiteNumber(segment.timing?.totalMs) ? segment.timing.totalMs : 0),
    0,
  );
  if (
    finiteNumber(value.dispatch?.durationMs)
    && value.dispatch.durationMs !== dispatchDuration
  ) {
    errors.push(`unit.dispatch.durationMs: expected ${dispatchDuration} from segments`);
  }
  const segmentDuration = segments.reduce(
    (sum, segment) => sum + (finiteNumber(segment.timing?.totalMs) ? segment.timing.totalMs : 0),
    0,
  );
  if (finiteNumber(value.timing?.totalMs) && segmentDuration > value.timing.totalMs) {
    errors.push('unit.timing.totalMs: cannot be shorter than its segment durations');
  }
  if (
    finiteNumber(value.timing?.timeToFirstSelectionMs)
    && value.timing?.steps?.selection !== value.timing.timeToFirstSelectionMs
  ) {
    errors.push(
      'unit.timing.timeToFirstSelectionMs: must equal unit.timing.steps.selection',
    );
  }
  const selectionSegments = segments.filter((segment) =>
    segment?.stage === 'selection');
  const selectionIndex = segments.findIndex((segment) => segment?.stage === 'selection');
  if (selectionSegments.length !== 1) {
    errors.push('segments: expected exactly one selection stage');
  }
  if (selectionIndex >= 0 && finiteNumber(value.timing?.timeToFirstSelectionMs)) {
    const throughSelection = segments.slice(0, selectionIndex + 1).reduce(
      (sum, segment) => sum + segment.timing.totalMs,
      0,
    );
    if (value.timing.timeToFirstSelectionMs < throughSelection) {
      errors.push(
        `unit.timing.timeToFirstSelectionMs: cannot be shorter than ${throughSelection} through selection`,
      );
    }
    if (value.timing.timeToFirstSelectionMs > value.timing.totalMs) {
      errors.push('unit.timing.timeToFirstSelectionMs: cannot exceed totalMs');
    }
  }
  const reviewRounds = new Set(
    segments
      .filter((segment) => segment.stage === 'code-review')
      .map((segment) => segment.round),
  ).size;
  if (integer(value.dispatch?.reviewRounds) && value.dispatch.reviewRounds !== reviewRounds) {
    errors.push(`unit.dispatch.reviewRounds: expected ${reviewRounds} from segments`);
  }
  for (const key of ['githubApi', 'subprocesses', 'remoteMutations']) {
    if (
      integer(recordValue.instrumentationOverhead?.[key])
      && integer(value.calls?.[key])
      && recordValue.instrumentationOverhead[key] > value.calls[key]
    ) {
      errors.push(`instrumentationOverhead.${key}: cannot exceed unit.calls.${key}`);
    }
  }
  if (
    finiteNumber(recordValue.instrumentationOverhead?.durationMs)
    && finiteNumber(value.timing?.totalMs)
    && recordValue.instrumentationOverhead.durationMs > value.timing.totalMs
  ) {
    errors.push('instrumentationOverhead.durationMs: cannot exceed unit.timing.totalMs');
  }

  for (const key of UNIT_TELEMETRY_KEYS) {
    const segmentValues = segments.map(
      (segment) => observationValue(segment.telemetry?.[key]),
    );
    const unitValue = observationValue(value.telemetry?.[key]);
    const allObserved = segmentValues.every((candidate) => candidate !== null);
    if (allObserved && unitValue === null) {
      errors.push(`unit.telemetry.${key}: cannot be unavailable when every segment is observed`);
    } else if (
      !allObserved
      && unitValue !== null
      && value.telemetry?.[key]?.provenance?.method !== 'provider-unit-total'
    ) {
      errors.push(
        `unit.telemetry.${key}: unavailable segments require provider-unit-total provenance`,
      );
    } else if (allObserved) {
      const sum = segmentValues.reduce((total, candidate) => total + candidate, 0);
      const tolerance = key === 'costUsd' ? 1e-9 : 0;
      if (Math.abs(unitValue - sum) > tolerance) {
        errors.push(`unit.telemetry.${key}: must equal the observed segment sum`);
      }
    }
  }
}

function validateSegmentGrammar(errors, recordValue, segments) {
  if (
    segments.length === 0
    || Array.from({ length: segments.length }, (_, index) => segments[index])
      .some((segment) => !plainObject(segment))
  ) return;
  const flow = recordValue.intent?.flow;
  const counts = new Map();
  for (const segment of segments) {
    const key = `${segment.stage}:${segment.round}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [key, count] of counts) {
    if (count > 1) errors.push(`segments: duplicate stage/round ${key}`);
  }
  for (const stage of STAGES) {
    if (stage === 'code-review') continue;
    const count = segments.filter((segment) => segment.stage === stage).length;
    if (count > 1) errors.push(`segments: ${stage} may appear at most once`);
  }
  const reviews = segments
    .filter((segment) => segment.stage === 'code-review')
    .map((segment) => segment.round);
  reviews.forEach((round, index) => {
    if (round !== index + 1) errors.push('segments: code-review rounds must be contiguous from 1');
  });
  const orderedStages = flow === 'dev'
    ? [
      'premise',
      'selection',
      'recovery',
      'planning',
      'plan-review',
      'claim',
      'implementation',
      'simplify',
      'diff-review',
      'code-review',
      'judgment-review',
      'gate',
      'delivery',
    ]
    : [
      'premise',
      'selection',
      'recovery',
      'claim',
      'implementation',
      'simplify',
      'diff-review',
      'code-review',
      'judgment-review',
      'gate',
      'delivery',
    ];
  const ranks = Object.fromEntries(orderedStages.map((stage, index) => [stage, index]));
  if (flow === 'pitcrew' && segments.some((segment) => segment.stage === 'plan-review')) {
    errors.push('segments: Pitcrew cannot contain plan-review');
  }
  let previous = -1;
  for (const segment of segments) {
    const rank = ranks[segment.stage];
    if (rank === undefined || rank < previous) {
      errors.push(`segments: invalid ${flow} stage order at ${segment.stage}`);
      break;
    }
    previous = rank;
  }
  const terminal = recordValue.unit?.outcomes?.terminal;
  const last = segments.at(-1);
  if (terminal?.stage !== last?.stage) {
    errors.push('unit.outcomes.terminal.stage: must equal the final segment stage');
  }
  const gates = segments.filter((segment) => segment.stage === 'gate').length;
  const deliveries = segments.filter((segment) => segment.stage === 'delivery').length;
  const gateResult = recordValue.unit?.outcomes?.gate?.result;
  if (gates === 0 && gateResult !== 'not-run') {
    errors.push('unit.outcomes.gate.result: must be not-run when no gate segment exists');
  }
  if (gates === 1 && gateResult === 'not-run') {
    errors.push('unit.outcomes.gate.result: gate segment requires an observed result');
  }
  if (gateResult === 'failed' && terminal?.stage !== 'gate') {
    errors.push('unit.outcomes.gate.result: failed gate must be the terminal stage');
  }
  const mandatory = flow === 'dev'
    ? [
      'premise',
      'selection',
      'planning',
      'plan-review',
      'claim',
      'implementation',
      'simplify',
      'diff-review',
      'code-review',
      'gate',
      'delivery',
    ]
    : [
      'premise',
      'selection',
      'claim',
      'implementation',
      'simplify',
      'diff-review',
      'code-review',
      'gate',
      'delivery',
    ];
  const lastRank = ranks[last?.stage];
  for (const stage of mandatory) {
    if (
      ranks[stage] <= lastRank
      && !segments.some((segment) => segment.stage === stage)
    ) errors.push(`segments: missing required ${stage} before terminal ${last?.stage}`);
  }
  if (terminal?.status === 'completed') {
    if (last?.stage !== 'delivery' || gates !== 1 || deliveries !== 1) {
      errors.push('unit.outcomes.terminal: completed units require one gate then one delivery');
    }
    if (!['first-pass', 'after-retry'].includes(gateResult)) {
      errors.push('unit.outcomes.gate.result: completed units require a successful gate');
    }
  } else if (deliveries > 0) {
    errors.push('segments: only completed units may contain delivery');
  }
  const recovery = recordValue.unit?.outcomes?.recovery;
  const source = recordValue.intent?.source;
  if (source === 'invocation' && recovery?.resumeKind !== 'fresh') {
    errors.push('unit.outcomes.recovery.resumeKind: invocation must be fresh');
  }
  if (source === 'relaunch' && !['resumed', 'restarted'].includes(recovery?.resumeKind)) {
    errors.push('unit.outcomes.recovery.resumeKind: relaunch must be resumed or restarted');
  }
  if (source === 'orphan-recovery' && recovery?.resumeKind !== 'resumed') {
    errors.push('unit.outcomes.recovery.resumeKind: orphan recovery must be resumed');
  }
  if (
    source !== 'invocation'
    && !segments.some((segment) => segment.stage === 'recovery')
  ) errors.push('segments: resumed/recovered intent requires a recovery segment');
  if (recovery?.resumeKind === 'fresh' && recovery?.recoveryKind !== 'not-needed') {
    errors.push('unit.outcomes.recovery.recoveryKind: fresh units require not-needed');
  }
  if (
    ['resumed', 'restarted'].includes(recovery?.resumeKind)
    && recovery?.recoveryKind === 'not-needed'
  ) {
    errors.push('unit.outcomes.recovery.recoveryKind: resumed units require recovery evidence');
  }
}

export function validateMeasurement(value) {
  const graph = validateDataGraph(value);
  if (!graph.ok) return graph;
  const errors = [];
  if (!exactObject(errors, 'record', value, RECORD_KEYS, ['legacyProfile', 'provenance'])) {
    return { ok: false, errors };
  }
  if (value.version !== MEASUREMENT_VERSION) {
    errors.push(`version: expected ${MEASUREMENT_VERSION}`);
  }
  if (!UUID_RE.test(value.recordId ?? '')) errors.push('recordId: expected a lowercase UUID v4');
  if (!canonicalTimestamp(value.capturedAt)) {
    errors.push('capturedAt: expected a canonical UTC timestamp');
  } else if (Date.parse(value.capturedAt) > Date.now() + 5 * 60 * 1000) {
    errors.push('capturedAt: future timestamps are invalid');
  }
  if (!SHA_RE.test(value.revision ?? '')) errors.push('revision: expected a lowercase commit OID');
  if (!NAME_RE.test(value.workload ?? '')) errors.push('workload: invalid workload identifier');
  requireEnum(errors, 'checkpoint', value.checkpoint, CHECKPOINTS);
  if (!HASH_RE.test(value.comparisonContextFingerprint ?? '')) {
    errors.push('comparisonContextFingerprint: expected sha256');
  }
  if (!HASH_RE.test(value.checkpointEndpointFingerprint ?? '')) {
    errors.push('checkpointEndpointFingerprint: expected sha256');
  }
  requireEnum(errors, 'activeHost', value.activeHost, HOSTS);
  requireEnum(errors, 'selector', value.selector, SELECTORS);
  requireEnum(errors, 'requestedEngine', value.requestedEngine, HOSTS);
  requireEnum(errors, 'requestedRoute', value.requestedRoute, ROUTES);
  if (value.intentProvenance !== INTENT_PROVENANCE) {
    errors.push(`intentProvenance: expected ${INTENT_PROVENANCE}`);
  }
  requireEnum(errors, 'lane', value.lane, LANES);
  requireEnum(errors, 'mergePolicy', value.mergePolicy, MERGE_POLICIES);
  requireEnum(
    errors,
    'baseFreshnessStrategy',
    value.baseFreshnessStrategy,
    BASE_STRATEGIES,
  );
  if (exactObject(errors, 'intent', value.intent, INTENT_KEYS)) {
    requireEnum(errors, 'intent.flow', value.intent.flow, FLOWS);
    requireEnum(errors, 'intent.source', value.intent.source, INTENT_SOURCES);
  }
  if (!HASH_RE.test(value.configFingerprint ?? '')) {
    errors.push('configFingerprint: expected sha256');
  }
  if (!HASH_RE.test(value.capabilityFingerprint ?? '')) {
    errors.push('capabilityFingerprint: expected sha256');
  }
  if (!HASH_RE.test(value.outageFingerprint ?? '')) {
    errors.push('outageFingerprint: expected sha256');
  }
  if (value.outageTransition !== null) {
    requireString(errors, 'outageTransition', value.outageTransition, 200);
  }
  if (exactObject(errors, 'instrumentationOverhead', value.instrumentationOverhead, OVERHEAD_KEYS)) {
    requireNumber(
      errors,
      'instrumentationOverhead.durationMs',
      value.instrumentationOverhead.durationMs,
    );
    for (const key of OVERHEAD_KEYS.filter((candidate) => candidate !== 'durationMs')) {
      requireNumber(
        errors,
        `instrumentationOverhead.${key}`,
        value.instrumentationOverhead[key],
        true,
      );
    }
  }

  const expectedEngine = value.selector === 'native' ? value.activeHost : value.selector;
  if (HOSTS.has(value.activeHost) && SELECTORS.has(value.selector)) {
    if (value.requestedEngine !== expectedEngine) {
      errors.push(`requestedEngine: expected ${JSON.stringify(expectedEngine)} from selector`);
    }
    const expectedRoute = expectedRequestedRoute(value.activeHost, expectedEngine);
    if (expectedRoute === null) {
      errors.push('requestedRoute: unsupported active-host/requested-engine pair');
    } else if (value.requestedRoute !== expectedRoute) {
      errors.push(`requestedRoute: expected ${expectedRoute}`);
    }
  }
  if (ROUTES.has(value.requestedRoute)) {
    const route = ROUTE_CATALOG[value.requestedRoute];
    if (
      route.activeHost !== value.activeHost
      || route.requestedEngine !== value.requestedEngine
    ) {
      errors.push('requestedRoute: inconsistent with activeHost and requestedEngine');
    }
  }
  if (value.legacyProfile !== undefined) {
    requireEnum(errors, 'legacyProfile', value.legacyProfile, HOSTS);
  }
  if (exactObject(errors, 'observation', value.observation, OBSERVATION_KEYS)) {
    if (!UUID_RE.test(value.observation.runId ?? '')) {
      errors.push('observation.runId: expected UUID v4');
    }
    if (!NAME_RE.test(value.observation.unitId ?? '')) {
      errors.push('observation.unitId: invalid unit identifier');
    }
    if (!HASH_RE.test(value.observation.runtimeRunFingerprint ?? '')) {
      errors.push('observation.runtimeRunFingerprint: expected sha256');
    }
    if (!HASH_RE.test(value.observation.terminalEvidenceFingerprint ?? '')) {
      errors.push('observation.terminalEvidenceFingerprint: expected sha256');
    }
  }
  if (value.provenance !== undefined) {
    if (exactObject(errors, 'provenance', value.provenance, PROVENANCE_KEYS, ['derivation'])) {
      if (value.provenance.kind !== 'tool-authenticated') {
        errors.push('provenance.kind: expected tool-authenticated');
      }
      if (!UUID_RE.test(value.provenance.storeId ?? '')) {
        errors.push('provenance.storeId: expected UUID v4');
      }
      if (!canonicalTimestamp(value.provenance.authenticatedAt)) {
        errors.push('provenance.authenticatedAt: expected canonical UTC timestamp');
      }
      if (!HASH_RE.test(value.provenance.contentFingerprint ?? '')) {
        errors.push('provenance.contentFingerprint: expected sha256');
      } else if (value.provenance.contentFingerprint !== recordContentFingerprint(value)) {
        errors.push('provenance.contentFingerprint: record content changed');
      }
      if (!HASH_RE.test(value.provenance.observationFingerprint ?? '')) {
        errors.push('provenance.observationFingerprint: expected sha256');
      } else if (
        value.provenance.observationFingerprint !== observationFingerprint(value)
      ) {
        errors.push('provenance.observationFingerprint: observation content changed');
      }
      if (exactObject(errors, 'provenance.capture', value.provenance.capture, CAPTURE_KEYS)) {
        if (value.provenance.capture.revisionSource !== 'live-git-head') {
          errors.push('provenance.capture.revisionSource: expected live-git-head');
        }
        if (value.provenance.capture.timeSource !== 'tool-clock') {
          errors.push('provenance.capture.timeSource: expected tool-clock');
        }
        if (value.provenance.capture.checkpointSource !== 'operator-declared') {
          errors.push('provenance.capture.checkpointSource: expected operator-declared');
        }
        if (
          !['run-record-declared', 'derived-authenticated-events'].includes(
            value.provenance.capture.observationSource,
          )
        ) {
          errors.push(
            'provenance.capture.observationSource: expected declared or derived event source',
          );
        }
      }
      if (value.provenance.derivation !== undefined) {
        const derivation = value.provenance.derivation;
        if (exactObject(
          errors,
          'provenance.derivation',
          derivation,
          EVENT_DERIVATION_KEYS,
        )) {
          if (derivation.pipelineVersion !== MEASUREMENT_EVENT_VERSION) {
            errors.push(
              `provenance.derivation.pipelineVersion: expected ${MEASUREMENT_EVENT_VERSION}`,
            );
          }
          if (!UUID_RE.test(derivation.runId ?? '')) {
            errors.push('provenance.derivation.runId: expected UUID v4');
          }
          if (derivation.runId !== value.observation?.runId) {
            errors.push('provenance.derivation.runId: must equal observation.runId');
          }
          if (!SHA_RE.test(derivation.startRevision ?? '')) {
            errors.push('provenance.derivation.startRevision: expected commit OID');
          }
          if (
            !Number.isSafeInteger(derivation.eventCount)
            || derivation.eventCount < 2
            || derivation.eventCount > MAX_RUN_EVENTS
          ) {
            errors.push('provenance.derivation.eventCount: expected bounded event count');
          }
          if (!HASH_RE.test(derivation.eventSetFingerprint ?? '')) {
            errors.push('provenance.derivation.eventSetFingerprint: expected sha256');
          }
        }
        if (value.provenance.capture?.observationSource !== 'derived-authenticated-events') {
          errors.push('provenance.derivation: requires derived-authenticated-events capture');
        }
      } else if (
        value.provenance.capture?.observationSource === 'derived-authenticated-events'
      ) {
        errors.push('provenance.derivation: required for derived event capture');
      }
      if (!HASH_RE.test(value.provenance.mac ?? '')) {
        errors.push('provenance.mac: expected sha256 HMAC');
      }
    }
  }
  if (denseArray(errors, 'segments', value.segments, 1, 64)) {
    const ids = new Set();
    value.segments.forEach((segment, index) => {
      validateSegment(errors, value, segment, index);
      if (ids.has(segment?.id)) errors.push(`segments[${index}].id: duplicate identifier`);
      ids.add(segment?.id);
    });
  }
  validateUnit(errors, value);
  return { ok: errors.length === 0, errors };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!plainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
  );
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function recordContent(recordValue) {
  const copy = { ...recordValue };
  delete copy.provenance;
  return copy;
}

function recordContentFingerprint(recordValue) {
  return fingerprint(recordContent(recordValue));
}

function markDerivedRecord(recordValue, derivation) {
  DERIVED_RECORDS.set(recordValue, structuredClone(derivation));
  return recordValue;
}

function markTrustedDerivedRecord(recordValue, derivation) {
  markDerivedRecord(recordValue, derivation);
  TRUSTED_DERIVED_RECORDS.add(recordValue);
  return recordValue;
}

function isTrustedDerivedRecord(recordValue) {
  return isTrustedRecord(recordValue) && TRUSTED_DERIVED_RECORDS.has(recordValue);
}

function observationFingerprint(recordValue) {
  const content = recordContent(recordValue);
  delete content.recordId;
  delete content.capturedAt;
  delete content.observation;
  return fingerprint(content);
}

function trustRecord(recordValue) {
  TRUSTED_RECORDS.set(recordValue, {
    contentFingerprint: recordValue.provenance.contentFingerprint,
    observationFingerprint: recordValue.provenance.observationFingerprint,
    mac: recordValue.provenance.mac,
    storeId: recordValue.provenance.storeId,
  });
}

function isTrustedRecord(recordValue) {
  const trusted = TRUSTED_RECORDS.get(recordValue);
  return (
    trusted !== undefined
    && trusted.contentFingerprint === recordContentFingerprint(recordValue)
    && trusted.contentFingerprint === recordValue.provenance?.contentFingerprint
    && trusted.observationFingerprint === observationFingerprint(recordValue)
    && trusted.observationFingerprint === recordValue.provenance?.observationFingerprint
    && trusted.mac === recordValue.provenance?.mac
    && trusted.storeId === recordValue.provenance?.storeId
  );
}

function validateEvidenceReference(errors, path, value, expected = {}) {
  if (!plainObject(value)) {
    errors.push(`${path}: expected observed fingerprint or typed unavailable`);
    return;
  }
  if (value.status === 'observed') {
    if (!exactObject(errors, path, value, EVIDENCE_REFERENCE_OBSERVED_KEYS)) return;
    if (
      exactObject(
        errors,
        `${path}.envelope`,
        value.envelope,
        TYPED_ENVELOPE_KEYS,
      )
    ) {
      const envelope = value.envelope;
      if (envelope.version !== 1) errors.push(`${path}.envelope.version: expected 1`);
      requireEnum(
        errors,
        `${path}.envelope.producer`,
        envelope.producer,
        ENVELOPE_PRODUCERS,
      );
      requireEnum(errors, `${path}.envelope.type`, envelope.type, ENVELOPE_TYPES);
      if (!UUID_RE.test(envelope.runId ?? '')) {
        errors.push(`${path}.envelope.runId: expected UUID v4`);
      }
      if (!NAME_RE.test(envelope.subjectId ?? '')) {
        errors.push(`${path}.envelope.subjectId: invalid identifier`);
      }
      if (!plainObject(envelope.payload)) {
        errors.push(`${path}.envelope.payload: expected a typed data object`);
      }
      if (!HASH_RE.test(envelope.payloadFingerprint ?? '')) {
        errors.push(`${path}.envelope.payloadFingerprint: expected sha256`);
      } else if (
        envelope.payloadFingerprint !== fingerprint(envelope.payload)
      ) {
        errors.push(`${path}.envelope.payloadFingerprint: payload changed`);
      }
      if (expected.runId !== undefined && envelope.runId !== expected.runId) {
        errors.push(`${path}.envelope.runId: does not match event run`);
      }
      if (
        expected.subjectId !== undefined
        && envelope.subjectId !== expected.subjectId
      ) {
        errors.push(`${path}.envelope.subjectId: does not match event subject`);
      }
      if (
        expected.producer !== undefined
        && envelope.producer !== expected.producer
      ) {
        errors.push(`${path}.envelope.producer: expected ${expected.producer}`);
      }
      if (
        expected.type !== undefined
        && envelope.type !== expected.type
      ) {
        errors.push(`${path}.envelope.type: expected ${expected.type}`);
      }
    }
    if (!HASH_RE.test(value.fingerprint ?? '')) {
      errors.push(`${path}.fingerprint: expected sha256`);
    } else if (value.fingerprint !== fingerprint(value.envelope)) {
      errors.push(`${path}.fingerprint: envelope changed`);
    }
    return;
  }
  if (value.status === 'unavailable') {
    if (!exactObject(errors, path, value, EVIDENCE_REFERENCE_UNAVAILABLE_KEYS)) return;
    requireString(errors, `${path}.reason`, value.reason);
    return;
  }
  errors.push(`${path}.status: expected observed or unavailable`);
}

function validRetainedRuntimeRun(value) {
  return plainObject(value)
    && value.version === 1
    && HASH_RE.test(value.instanceFingerprint ?? '')
    && HASH_RE.test(value.authorization ?? '')
    && HASH_RE.test(value.configFingerprint ?? '')
    && HASH_RE.test(value.sessionFingerprint ?? '')
    && HOSTS.has(value.activeHost)
    && SELECTORS.has(value.selector)
    && HOSTS.has(value.requestedEngine)
    && ROUTES.has(value.requestedRoute)
    && value.intentProvenance === INTENT_PROVENANCE
    && FLOWS.has(value.invocationFlow);
}

function validRetainedRuntimeReceipt(value) {
  if (
    !plainObject(value)
    || value.version !== 1
    || !HASH_RE.test(value.fingerprint ?? '')
    || !HASH_RE.test(value.authorization ?? '')
    || !HASH_RE.test(value.runInstanceFingerprint ?? '')
    || !HASH_RE.test(value.configFingerprint ?? '')
    || !HOSTS.has(value.activeHost)
    || !SELECTORS.has(value.selector)
    || !HOSTS.has(value.requestedEngine)
    || !ROUTES.has(value.requestedRoute)
    || value.intentProvenance !== INTENT_PROVENANCE
    || !ROUTES.has(value.actualRoute)
    || value.adapter !== value.actualRoute
    || !['dev', 'pitcrew', 'doctor'].includes(value.invocationFlow)
    || !['plan-review', 'implementation', 'code-review', 'judgment-review', 'doctor']
      .includes(value.stage)
    || !Number.isInteger(value.round)
    || value.round < 1
    || !['writer', 'reviewer', 'probe'].includes(value.role)
    || !LANES.has(value.effectiveLane)
    || !HASH_RE.test(value.laneProofFingerprint ?? '')
    || !HASH_RE.test(value.capabilityFingerprint ?? '')
    || !plainObject(value.routeState)
    || !HASH_RE.test(value.routeState.fingerprint ?? '')
    || value.routeState.capabilityFingerprint !== value.capabilityFingerprint
    || !OUTAGE_TRANSITIONS.includes(value.outageTransition)
    || !Array.isArray(value.degradation)
    || !Array.isArray(value.reviewVerdicts)
  ) {
    return false;
  }
  const unsigned = { ...value };
  delete unsigned.fingerprint;
  return value.fingerprint === fingerprint(unsigned);
}

function runtimeReviewFacts(receipt) {
  const verdict = receipt?.role === 'reviewer'
    ? receipt.reviewVerdicts?.at(-1)?.verdict
    : null;
  if (receipt?.role === 'reviewer' && !plainObject(verdict)) return null;
  const findings = (verdict?.findings ?? [])
    .filter((finding) => ['Critical', 'Major', 'Minor'].includes(finding?.severity))
    .map((finding) => ({
      id: finding.id,
      severity: finding.severity.toLowerCase(),
    }));
  const retainedIds = new Set(findings.map((finding) => finding.id));
  const rebuts = (verdict?.rebuts ?? [])
    .filter((rebut) => retainedIds.has(rebut?.findingId))
    .map((rebut) => ({
      findingId: rebut.findingId,
      disposition: rebut.status,
    }));
  return { findings, rebuts };
}

function validateRunStartEvent(errors, payload, runId) {
  if (!exactObject(errors, 'event.payload', payload, RUN_START_KEYS)) return;
  if (!NAME_RE.test(payload.workload ?? '')) errors.push('event.payload.workload: invalid identifier');
  requireEnum(errors, 'event.payload.checkpoint', payload.checkpoint, CHECKPOINTS);
  for (const key of [
    'comparisonContextFingerprint',
    'checkpointEndpointFingerprint',
    'configFingerprint',
  ]) {
    if (!HASH_RE.test(payload[key] ?? '')) errors.push(`event.payload.${key}: expected sha256`);
  }
  requireEnum(errors, 'event.payload.activeHost', payload.activeHost, HOSTS);
  requireEnum(errors, 'event.payload.selector', payload.selector, SELECTORS);
  requireEnum(errors, 'event.payload.requestedEngine', payload.requestedEngine, HOSTS);
  requireEnum(errors, 'event.payload.requestedRoute', payload.requestedRoute, ROUTES);
  if (payload.intentProvenance !== INTENT_PROVENANCE) {
    errors.push(`event.payload.intentProvenance: expected ${INTENT_PROVENANCE}`);
  }
  requireEnum(errors, 'event.payload.mergePolicy', payload.mergePolicy, MERGE_POLICIES);
  requireEnum(
    errors,
    'event.payload.baseFreshnessStrategy',
    payload.baseFreshnessStrategy,
    BASE_STRATEGIES,
  );
  if (exactObject(errors, 'event.payload.intent', payload.intent, INTENT_KEYS)) {
    requireEnum(errors, 'event.payload.intent.flow', payload.intent.flow, FLOWS);
    requireEnum(errors, 'event.payload.intent.source', payload.intent.source, INTENT_SOURCES);
  }
  validateEvidenceReference(
    errors,
    'event.payload.runtimeBinding',
    payload.runtimeBinding,
    {
      runId,
      producer: 'runtime',
      type: 'run-context',
    },
  );
  if (payload.runtimeBinding?.status === 'observed') {
    const binding = payload.runtimeBinding.envelope?.payload;
    const run = binding?.run;
    if (
      !plainObject(binding)
      || Object.keys(binding).sort().join(',') !== 'run'
      || !validRetainedRuntimeRun(run)
      || payload.runtimeBinding.envelope.subjectId !== run?.instanceFingerprint
      || payload.activeHost !== run?.activeHost
      || payload.selector !== run?.selector
      || payload.requestedEngine !== run?.requestedEngine
      || payload.requestedRoute !== run?.requestedRoute
      || payload.intentProvenance !== run?.intentProvenance
      || payload.intent?.flow !== run?.invocationFlow
      || payload.configFingerprint !== run?.configFingerprint
    ) {
      errors.push(
        'event.payload.runtimeBinding: exact Runtime context does not match run facts',
      );
    }
  }
  const expectedEngine =
    payload.selector === 'native' ? payload.activeHost : payload.selector;
  const expectedRoute = expectedRequestedRoute(payload.activeHost, expectedEngine);
  if (
    payload.requestedEngine !== expectedEngine
    || payload.requestedRoute !== expectedRoute
  ) {
    errors.push('event.payload: selector, requested engine, and route are inconsistent');
  }
}

function validateUnitContextEvent(errors, payload) {
  if (!exactObject(errors, 'event.payload', payload, UNIT_CONTEXT_KEYS)) return;
  if (!NAME_RE.test(payload.unitId ?? '')) {
    errors.push('event.payload.unitId: invalid identifier');
  }
  requireEnum(errors, 'event.payload.initialLane', payload.initialLane, LANES);
  if (!HASH_RE.test(payload.initialLaneProofFingerprint ?? '')) {
    errors.push('event.payload.initialLaneProofFingerprint: expected sha256');
  }
  if (!HASH_RE.test(payload.planFingerprint ?? '')) {
    errors.push('event.payload.planFingerprint: expected sha256');
  }
  if (!HASH_RE.test(payload.capabilityFingerprint ?? '')) {
    errors.push('event.payload.capabilityFingerprint: expected sha256');
  }
  if (!HASH_RE.test(payload.outageFingerprint ?? '')) {
    errors.push('event.payload.outageFingerprint: expected sha256');
  }
}

function validateStageStartEvent(errors, payload) {
  if (!exactObject(errors, 'event.payload', payload, STAGE_START_KEYS)) return;
  if (!NAME_RE.test(payload.id ?? '')) errors.push('event.payload.id: invalid identifier');
  requireEnum(errors, 'event.payload.stage', payload.stage, STAGES);
  if (!Number.isInteger(payload.round) || payload.round < 1 || payload.round > 100) {
    errors.push('event.payload.round: expected 1..100');
  }
}

function validateStageEndEvent(errors, payload, runId) {
  if (!exactObject(errors, 'event.payload', payload, STAGE_END_KEYS)) return;
  if (!NAME_RE.test(payload.stageId ?? '')) {
    errors.push('event.payload.stageId: invalid identifier');
  }
  requireEnum(errors, 'event.payload.actualRoute', payload.actualRoute, ROUTES);
  requireEnum(errors, 'event.payload.adapter', payload.adapter, ROUTES);
  validateDegradation(errors, 'event.payload.degradation', payload.degradation);
  validateTelemetry(errors, 'event.payload.telemetry', payload.telemetry, true);
  validateEvidenceReference(
    errors,
    'event.payload.providerEvidence',
    payload.providerEvidence,
    {
      runId,
      subjectId: payload.stageId,
      producer: 'provider',
      type: 'provider-accounting',
    },
  );
  if (
    payload.providerEvidence?.status === 'unavailable'
    && SEGMENT_TELEMETRY_KEYS.some(
      (key) => payload.telemetry?.[key]?.status !== 'unavailable',
    )
  ) {
    errors.push(
      'event.payload.telemetry: unavailable provider evidence requires every field unavailable',
    );
  }
  if (
    payload.providerEvidence?.status === 'observed'
    && !sameValue(
      payload.providerEvidence.envelope?.payload?.telemetry,
      payload.telemetry,
    )
  ) {
    errors.push(
      'event.payload.providerEvidence: exact envelope telemetry must match stage telemetry',
    );
  }
}

function validateWaitEvent(errors, payload) {
  if (!exactObject(errors, 'event.payload', payload, WAIT_EVENT_KEYS)) return;
  if (!NAME_RE.test(payload.stageId ?? '')) {
    errors.push('event.payload.stageId: invalid identifier');
  }
  if (!NAME_RE.test(payload.waitId ?? '')) errors.push('event.payload.waitId: invalid identifier');
  requireEnum(errors, 'event.payload.category', payload.category, WAIT_CATEGORIES);
}

function validateCommandResult(errors, path, value, operationKind) {
  if (!exactObject(errors, path, value, COMMAND_RESULT_KEYS)) return;
  if (value.version !== 1) errors.push(`${path}.version: expected 1`);
  if (value.operationKind !== operationKind) {
    errors.push(`${path}.operationKind: does not match the operation`);
  }
  requireEnum(errors, `${path}.status`, value.status, COMMAND_RESULT_STATUSES);
  for (const key of [
    'executableFingerprint',
    'argumentsFingerprint',
    'cwdFingerprint',
  ]) {
    if (!HASH_RE.test(value[key] ?? '')) errors.push(`${path}.${key}: expected sha256`);
  }
  for (const key of ['startedAt', 'finishedAt']) {
    if (!canonicalTimestamp(value[key])) {
      errors.push(`${path}.${key}: expected canonical UTC timestamp`);
    }
  }
  requireNumber(errors, `${path}.durationMs`, value.durationMs, true);
  if (
    !(value.exitCode === null
      || Number.isSafeInteger(value.exitCode) && value.exitCode >= 0)
  ) {
    errors.push(`${path}.exitCode: expected null or a non-negative integer`);
  }
  if (!(value.signal === null || typeof value.signal === 'string')) {
    errors.push(`${path}.signal: expected null or a string`);
  }
  for (const key of ['stdout', 'stderr']) {
    const streamPath = `${path}.${key}`;
    if (!exactObject(errors, streamPath, value[key], COMMAND_STREAM_KEYS)) continue;
    requireNumber(errors, `${streamPath}.bytes`, value[key].bytes, true);
    if (!HASH_RE.test(value[key].sha256 ?? '')) {
      errors.push(`${streamPath}.sha256: expected sha256`);
    }
  }
  if (
    value.status === 'exited'
      ? value.exitCode === null || value.signal !== null
      : value.status === 'signaled'
        ? value.exitCode !== null || typeof value.signal !== 'string'
        : value.exitCode !== null || value.signal !== null
  ) {
    errors.push(`${path}: status, exitCode, and signal are inconsistent`);
  }
}

function validateOperationEvent(errors, payload, runId) {
  if (!exactObject(errors, 'event.payload', payload, OPERATION_KEYS)) return;
  if (!NAME_RE.test(payload.stageId ?? '')) {
    errors.push('event.payload.stageId: invalid identifier');
  }
  if (!NAME_RE.test(payload.operationId ?? '')) {
    errors.push('event.payload.operationId: invalid identifier');
  }
  requireEnum(errors, 'event.payload.kind', payload.kind, OPERATION_KINDS);
  requireString(errors, 'event.payload.action', payload.action, 200);
  validateEvidenceReference(errors, 'event.payload.evidence', payload.evidence, {
    runId,
    subjectId: payload.operationId,
    producer: 'command-wrapper',
    type: `${payload.kind}-result`,
  });
  if (payload.evidence?.status === 'observed') {
    validateCommandResult(
      errors,
      'event.payload.evidence.envelope.payload',
      payload.evidence.envelope?.payload,
      payload.kind,
    );
  }
}

function validateDispatchEvent(errors, payload, runId) {
  if (!exactObject(errors, 'event.payload', payload, DISPATCH_EVENT_KEYS)) return;
  if (!NAME_RE.test(payload.stageId ?? '')) {
    errors.push('event.payload.stageId: invalid identifier');
  }
  if (!NAME_RE.test(payload.dispatchId ?? '')) {
    errors.push('event.payload.dispatchId: invalid identifier');
  }
  validateEvidenceReference(
    errors,
    'event.payload.runtimeReceipt',
    payload.runtimeReceipt,
    {
      runId,
      subjectId: payload.dispatchId,
      producer: 'runtime',
      type: 'runtime-receipt',
    },
  );
  if (denseArray(errors, 'event.payload.findings', payload.findings, 0, 1000)) {
    for (const [index, finding] of payload.findings.entries()) {
      const path = `event.payload.findings[${index}]`;
      if (!exactObject(errors, path, finding, RAW_FINDING_KEYS)) continue;
      if (!FINDING_ID_RE.test(finding.id ?? '')) {
        errors.push(`${path}.id: invalid identifier`);
      }
      requireEnum(errors, `${path}.severity`, finding.severity, FINDING_SEVERITIES);
    }
  }
  if (denseArray(errors, 'event.payload.rebuts', payload.rebuts, 0, 1000)) {
    for (const [index, rebut] of payload.rebuts.entries()) {
      const path = `event.payload.rebuts[${index}]`;
      if (!exactObject(errors, path, rebut, RAW_REBUT_KEYS)) continue;
      if (!FINDING_ID_RE.test(rebut.findingId ?? '')) {
        errors.push(`${path}.findingId: invalid identifier`);
      }
      requireEnum(errors, `${path}.disposition`, rebut.disposition, REBUT_DISPOSITIONS);
    }
  }
  if (payload.runtimeReceipt?.status === 'observed') {
    const receipt = payload.runtimeReceipt.envelope?.payload;
    const facts = runtimeReviewFacts(receipt);
    if (
      !validRetainedRuntimeReceipt(receipt)
      || receipt.fingerprint !== payload.dispatchId
      || facts === null
      || !sameValue(facts.findings, payload.findings)
      || !sameValue(facts.rebuts, payload.rebuts)
    ) {
      errors.push(
        'event.payload.runtimeReceipt: exact Runtime receipt does not match dispatch facts',
      );
    }
  }
}

function validateLifecycleEvent(errors, payload, runId) {
  if (!exactObject(errors, 'event.payload', payload, LIFECYCLE_EVENT_KEYS)) return;
  requireEnum(errors, 'event.payload.kind', payload.kind, LIFECYCLE_EVENT_KINDS);
  if (!NAME_RE.test(payload.subjectId ?? '')) {
    errors.push('event.payload.subjectId: invalid identifier');
  }
  validateEvidenceReference(errors, 'event.payload.evidence', payload.evidence, {
    runId,
    subjectId: payload.subjectId,
    producer: 'lifecycle-contract',
    type: 'lifecycle-result',
  });
  if (
    payload.evidence?.status === 'observed'
    && payload.evidence.envelope?.payload?.lifecycleKind !== payload.kind
  ) {
    errors.push(
      'event.payload.evidence: exact lifecycle envelope must match lifecycle kind',
    );
  }
}

function validateRunFinishEvent(errors, payload, runId) {
  if (!exactObject(errors, 'event.payload', payload, RUN_FINISH_KEYS)) return;
  if (exactObject(errors, 'event.payload.terminal', payload.terminal, TERMINAL_KEYS)) {
    requireEnum(
      errors,
      'event.payload.terminal.status',
      payload.terminal.status,
      TERMINAL_STATUSES,
    );
    requireEnum(errors, 'event.payload.terminal.stage', payload.terminal.stage, STAGES);
    if (payload.terminal.reason !== null) {
      requireString(errors, 'event.payload.terminal.reason', payload.terminal.reason);
    }
  }
  if (exactObject(errors, 'event.payload.gate', payload.gate, GATE_KEYS)) {
    requireEnum(errors, 'event.payload.gate.result', payload.gate.result, GATE_RESULTS);
    if (typeof payload.gate.localGreenCiRed !== 'boolean') {
      errors.push('event.payload.gate.localGreenCiRed: expected boolean');
    }
  }
  if (exactObject(errors, 'event.payload.recovery', payload.recovery, [
    'resumeKind',
    'recoveryKind',
  ])) {
    requireEnum(
      errors,
      'event.payload.recovery.resumeKind',
      payload.recovery.resumeKind,
      RESUME_KINDS,
    );
    requireEnum(
      errors,
      'event.payload.recovery.recoveryKind',
      payload.recovery.recoveryKind,
      RECOVERY_KINDS,
    );
  }
  validateEvidenceReference(
    errors,
    'event.payload.terminalEvidence',
    payload.terminalEvidence,
    {
      runId,
      subjectId: 'run-finish',
      producer: 'runtime',
      type: 'terminal-result',
    },
  );
  if (
    payload.terminalEvidence?.status === 'observed'
    && !sameValue(payload.terminalEvidence.envelope?.payload?.terminal, payload.terminal)
  ) {
    errors.push('event.payload.terminalEvidence: envelope must match terminal outcome');
  }
  if (
    payload.gateEvidence?.status === 'observed'
    && !sameValue(payload.gateEvidence.envelope?.payload?.gate, payload.gate)
  ) {
    errors.push('event.payload.gateEvidence: envelope must match gate outcome');
  }
  if (
    payload.lifecycleEvidence?.status === 'observed'
    && !sameValue(
      payload.lifecycleEvidence.envelope?.payload?.recovery,
      payload.recovery,
    )
  ) {
    errors.push('event.payload.lifecycleEvidence: envelope must match recovery outcome');
  }
  validateEvidenceReference(errors, 'event.payload.gateEvidence', payload.gateEvidence, {
    runId,
    subjectId: 'run-finish',
    producer: 'gate',
    type: 'gate-result',
  });
  validateEvidenceReference(
    errors,
    'event.payload.lifecycleEvidence',
    payload.lifecycleEvidence,
    {
      runId,
      subjectId: 'run-finish',
      producer: 'lifecycle-contract',
      type: 'lifecycle-result',
    },
  );
}

export function validateMeasurementEventInput(value) {
  const graph = validateDataGraph(value);
  if (!graph.ok) return graph;
  const errors = [];
  if (!exactObject(errors, 'event', value, EVENT_INPUT_KEYS)) return { ok: false, errors };
  if (value.version !== MEASUREMENT_EVENT_VERSION) {
    errors.push(`event.version: expected ${MEASUREMENT_EVENT_VERSION}`);
  }
  if (!UUID_RE.test(value.runId ?? '')) errors.push('event.runId: expected UUID v4');
  requireEnum(errors, 'event.kind', value.kind, EVENT_KINDS);
  if (EVENT_KINDS.has(value.kind)) {
    const validators = {
      'run-start': validateRunStartEvent,
      'unit-context': validateUnitContextEvent,
      'stage-start': validateStageStartEvent,
      'wait-start': validateWaitEvent,
      'wait-end': validateWaitEvent,
      operation: validateOperationEvent,
      dispatch: validateDispatchEvent,
      'stage-end': validateStageEndEvent,
      lifecycle: validateLifecycleEvent,
      'run-finish': validateRunFinishEvent,
    };
    validators[value.kind](errors, value.payload, value.runId);
  }
  return { ok: errors.length === 0, errors };
}

function evidenceFromTypedEnvelope(value, runId) {
  if (value?.status === 'unavailable') return structuredClone(value);
  const envelope = {
    version: 1,
    producer: value.producer,
    type: value.type,
    runId,
    subjectId: value.subjectId,
    payloadFingerprint: fingerprint(value.payload),
    payload: structuredClone(value.payload),
  };
  return {
    status: 'observed',
    fingerprint: fingerprint(envelope),
    envelope,
  };
}

function buildTypedMeasurementEventWithAuthority(input, allowObserved) {
  const graph = validateDataGraph(input);
  if (!graph.ok) return graph;
  const errors = [];
  if (!exactObject(errors, 'capture', input, TYPED_CAPTURE_KEYS)) {
    return { ok: false, errors };
  }
  if (input.version !== MEASUREMENT_EVENT_VERSION) {
    errors.push(`capture.version: expected ${MEASUREMENT_EVENT_VERSION}`);
  }
  if (!UUID_RE.test(input.runId ?? '')) errors.push('capture.runId: expected UUID v4');
  requireEnum(errors, 'capture.kind', input.kind, EVENT_KINDS);
  if (!allowObserved && input.kind === 'unit-context') {
    errors.push('capture.kind: unit-context must be captured by the Runtime broker');
  }
  if (!plainObject(input.payload)) {
    errors.push('capture.payload: expected a typed data object');
  }
  const envelopeKeys = TYPED_CAPTURE_ENVELOPE_KEYS[input.kind];
  if (envelopeKeys === undefined) return { ok: false, errors };
  if (exactObject(errors, 'capture.envelopes', input.envelopes, envelopeKeys)) {
    for (const key of envelopeKeys) {
      if (Object.hasOwn(input.payload ?? {}, key)) {
        errors.push(`capture.payload.${key}: supplied only through capture.envelopes`);
      }
      const envelope = input.envelopes[key];
      if (envelope?.status === 'unavailable') {
        if (!exactObject(
          errors,
          `capture.envelopes.${key}`,
          envelope,
          EVIDENCE_REFERENCE_UNAVAILABLE_KEYS,
        )) continue;
        requireString(errors, `capture.envelopes.${key}.reason`, envelope.reason);
        continue;
      }
      if (!allowObserved) {
        errors.push(
          `capture.envelopes.${key}: observed evidence must be captured by its producer contract`,
        );
        continue;
      }
      if (!exactObject(
        errors,
        `capture.envelopes.${key}`,
        envelope,
        ENVELOPE_INPUT_KEYS,
      )) continue;
      requireEnum(
        errors,
        `capture.envelopes.${key}.producer`,
        envelope.producer,
        ENVELOPE_PRODUCERS,
      );
      requireEnum(
        errors,
        `capture.envelopes.${key}.type`,
        envelope.type,
        ENVELOPE_TYPES,
      );
      if (!NAME_RE.test(envelope.subjectId ?? '')) {
        errors.push(`capture.envelopes.${key}.subjectId: invalid identifier`);
      }
      if (!plainObject(envelope.payload)) {
        errors.push(`capture.envelopes.${key}.payload: expected exact typed data object`);
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  const eventValue = {
    version: input.version,
    runId: input.runId,
    kind: input.kind,
    payload: structuredClone(input.payload),
  };
  for (const key of envelopeKeys) {
    eventValue.payload[key] = evidenceFromTypedEnvelope(
      input.envelopes[key],
      input.runId,
    );
  }
  const validation = validateMeasurementEventInput(eventValue);
  if (!validation.ok) return validation;
  return { ok: true, event: eventValue };
}

export function buildTypedMeasurementEvent(input) {
  return buildTypedMeasurementEventWithAuthority(input, false);
}

function buildProducerMeasurementEvent(input) {
  return buildTypedMeasurementEventWithAuthority(input, true);
}

function captureTypedMeasurementEvent(input, directory) {
  const built = buildTypedMeasurementEvent(input);
  if (!built.ok) return built;
  const envelopeKeys = TYPED_CAPTURE_ENVELOPE_KEYS[input.kind];
  return persistMeasurementEvent(
    built.event,
    directory,
    envelopeKeys.length === 0
      ? 'run-boundary-declared'
      : 'unavailable-evidence-declared',
  );
}

function captureProducerMeasurementEvent(input, directory, payloadSource) {
  if (!EVENT_PAYLOAD_SOURCES.has(payloadSource)
      || !payloadSource.endsWith('-verified')
        && !payloadSource.endsWith('-observed')) {
    return { ok: false, errors: ['producer payload source is invalid'] };
  }
  const built = buildProducerMeasurementEvent(input);
  if (!built.ok) return built;
  return persistMeasurementEvent(built.event, directory, payloadSource);
}

function currentMeasurementStage(directory, runId) {
  const retained = readMeasurementEvents(directory, runId);
  if (!retained.ok) return retained;
  if (retained.events.length === 0 || retained.events[0].kind !== 'run-start') {
    return { ok: false, errors: ['measurement run has no retained run-start'] };
  }
  if (retained.events.at(-1).kind === 'run-finish') {
    return { ok: false, errors: ['measurement run is already finished'] };
  }
  let stage = null;
  for (const eventValue of retained.events) {
    if (eventValue.kind === 'stage-start') {
      if (stage !== null) {
        return { ok: false, errors: ['measurement run has overlapping stages'] };
      }
      stage = eventValue.payload;
    } else if (eventValue.kind === 'stage-end') {
      if (stage === null || eventValue.payload.stageId !== stage.id) {
        return { ok: false, errors: ['measurement run has mismatched stage boundaries'] };
      }
      stage = null;
    }
  }
  if (stage === null) {
    return { ok: false, errors: ['measurement run has no active stage'] };
  }
  return { ok: true, stage, events: retained.events };
}

function structuredCommandIndex(args, optionsWithValues) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (optionsWithValues.has(argument)) {
      index += 1;
      continue;
    }
    if (
      [...optionsWithValues].some((option) =>
        argument.startsWith(`${option}=`))
      || argument.startsWith('-')
    ) {
      continue;
    }
    return index;
  }
  return -1;
}

function measuredOperationKind(executable, args) {
  const command = basename(executable);
  if (command === 'git') {
    const index = structuredCommandIndex(
      args,
      new Set([
        '-C',
        '-c',
        '--config-env',
        '--exec-path',
        '--git-dir',
        '--namespace',
        '--super-prefix',
        '--work-tree',
      ]),
    );
    const subcommand = index < 0 ? null : args[index];
    // Local working-tree subcommands are ordinary subprocess operations; only
    // `push` and unknown shapes stay conservatively remote (`init` is left
    // unknown on purpose — the loop never initializes repositories).
    const known = new Set([
      'add', 'apply', 'branch', 'cat-file', 'checkout', 'cherry-pick',
      'clean', 'commit', 'config', 'diff', 'diff-tree', 'fetch',
      'for-each-ref', 'log', 'ls-files', 'ls-remote', 'ls-tree', 'merge',
      'merge-base', 'merge-tree', 'mv', 'pull', 'rebase', 'remote', 'reset',
      'restore', 'rev-parse', 'revert', 'rm', 'show', 'stash', 'status',
      'switch', 'tag', 'update-ref', 'worktree',
    ]);
    if (subcommand === 'push') return 'remote-mutation';
    return subcommand !== null && known.has(subcommand)
      ? 'subprocess'
      : 'remote-mutation';
  }
  if (command !== 'gh') return 'subprocess';
  const commandIndex = structuredCommandIndex(
    args,
    new Set(['-R', '--hostname', '--repo']),
  );
  if (commandIndex < 0) return 'remote-mutation';
  const primary = args[commandIndex];
  const rest = args.slice(commandIndex + 1);
  if (primary === 'api') {
    let method = null;
    let hasFields = false;
    let query = null;
    let endpoint = null;
    let unknownFlag = false;
    const optionsWithValues = new Set([
      '--cache',
      '--header',
      '-H',
      '--hostname',
      '--jq',
      '-q',
      '--preview',
      '-p',
      '--template',
      '-t',
    ]);
    const optionsWithoutValues = new Set([
      '--include',
      '--paginate',
      '--silent',
      '--slurp',
      '--verbose',
    ]);
    for (let index = 0; index < rest.length; index += 1) {
      if (['--method', '-X'].includes(rest[index]) && rest[index + 1]) {
        method = rest[index + 1].toUpperCase();
        index += 1;
      } else if (rest[index].startsWith('--method=')) {
        method = rest[index].slice('--method='.length).toUpperCase();
      } else if (/^-X[A-Za-z]+$/u.test(rest[index])) {
        method = rest[index].slice(2).toUpperCase();
      } else if (
        ['-f', '-F', '--field', '--raw-field'].includes(rest[index])
        && rest[index + 1] !== undefined
      ) {
        hasFields = true;
        if (rest[index + 1].startsWith('query=')) {
          query = rest[index + 1].slice('query='.length).trimStart();
        }
        index += 1;
      } else if (/^(?:-f|-F|--field|--raw-field)=/u.test(rest[index])) {
        hasFields = true;
        const value = rest[index].replace(
          /^(?:-f|-F|--field|--raw-field)=/u,
          '',
        );
        if (value.startsWith('query=')) query = value.slice('query='.length).trimStart();
      } else if (/^-[fF][^=].*=/u.test(rest[index])) {
        hasFields = true;
        const value = rest[index].slice(2);
        if (value.startsWith('query=')) {
          query = value.slice('query='.length).trimStart();
        }
      } else if (
        rest[index] === '--input'
        || rest[index].startsWith('--input=')
      ) {
        hasFields = true;
        if (rest[index] === '--input') index += 1;
      } else if (optionsWithValues.has(rest[index])) {
        if (rest[index + 1] === undefined) unknownFlag = true;
        else index += 1;
      } else if (
        [...optionsWithValues].some((option) =>
          rest[index].startsWith(`${option}=`))
        || optionsWithoutValues.has(rest[index])
      ) {
        continue;
      } else if (rest[index].startsWith('-')) {
        unknownFlag = true;
      } else if (endpoint === null) {
        endpoint = rest[index];
      } else {
        unknownFlag = true;
      }
    }
    if (
      unknownFlag
      || method !== null && !/^[A-Z]+$/u.test(method)
      || endpoint === null
    ) {
      return 'remote-mutation';
    }
    if (endpoint === 'graphql') {
      if (query === null) return 'remote-mutation';
      return /^query\b/iu.test(query) || /^\{/u.test(query)
        ? 'github-api'
        : 'remote-mutation';
    }
    const effectiveMethod = method ?? (hasFields ? 'POST' : 'GET');
    return effectiveMethod === 'GET' ? 'github-api' : 'remote-mutation';
  }
  const readCommands = new Set([
    'alias list',
    'auth status',
    'cache list',
    'cache view',
    'issue list',
    'issue status',
    'issue view',
    'label list',
    'pr checks',
    'pr diff',
    'pr list',
    'pr status',
    'pr view',
    'release list',
    'release view',
    'repo list',
    'repo view',
    'run list',
    'run view',
    'run watch',
    'search code',
    'search commits',
    'search issues',
    'search prs',
    'search repos',
    'status ',
    'workflow list',
    'workflow view',
  ]);
  const secondary = rest.find((argument) => !argument.startsWith('-')) ?? '';
  const verb = `${primary} ${secondary}`;
  return readCommands.has(verb) ? 'github-api' : 'remote-mutation';
}

function shellLiteral(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function measuredCommandPolicy(input) {
  try {
    if (
      ['node', 'nodejs'].includes(basename(input.command.executable))
      && input.command.args.length === 1
      && ['--version', '-v'].includes(input.command.args[0])
    ) {
      return { block: false };
    }
    const root = realpathSync(gitExec(['rev-parse', '--show-toplevel']).trim());
    const installedState = join(root, 'docs', 'agentic', 'STATE.md');
    const sourceTemplate = join(root, 'templates', 'STATE.template.md');
    const baseBranch = existsSync(installedState)
      ? loadConfiguredBase(installedState)
      : existsSync(join(root, 'VERSION')) && existsSync(sourceTemplate)
        ? 'main'
        : loadConfiguredBase(installedState);
    const branch = gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim() || null;
    const command = [
      input.command.executable,
      ...input.command.args,
    ].map(shellLiteral).join(' ');
    return evaluateCommandPolicy(command, branch, { baseBranch });
  } catch (error) {
    return {
      block: true,
      reason: `structured command policy is unavailable: ${error.message}`,
    };
  }
}

function validMeasuredCommand(input) {
  const errors = [];
  if (!exactObject(errors, 'operation', input, MEASURED_OPERATION_INPUT_KEYS)) {
    return { ok: false, errors };
  }
  if (input.version !== 1) errors.push('operation.version: expected 1');
  if (!UUID_RE.test(input.runId ?? '')) errors.push('operation.runId: expected UUID v4');
  if (!NAME_RE.test(input.stageId ?? '')) errors.push('operation.stageId: invalid identifier');
  if (!NAME_RE.test(input.operationId ?? '')) {
    errors.push('operation.operationId: invalid identifier');
  }
  requireEnum(errors, 'operation.kind', input.kind, OPERATION_KINDS);
  requireString(errors, 'operation.action', input.action, 200);
  if (exactObject(errors, 'operation.command', input.command, MEASURED_COMMAND_KEYS)) {
    const { executable, args, cwd } = input.command;
    if (
      typeof executable !== 'string'
      || Buffer.byteLength(executable) < 1
      || Buffer.byteLength(executable) > 4096
      || /[\0\r\n]/u.test(executable)
      || !(isAbsolute(executable)
        || /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(executable))
    ) {
      errors.push('operation.command.executable: expected a bounded executable path or name');
    }
    if (
      !Array.isArray(args)
      || args.length > MAX_COMMAND_ARGS
      || args.some((argument) =>
        typeof argument !== 'string'
        || Buffer.byteLength(argument) > MAX_COMMAND_ARG_BYTES
        || argument.includes('\0'))
    ) {
      errors.push('operation.command.args: expected bounded string arguments');
    }
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
      errors.push('operation.command.cwd: expected an absolute path');
    } else {
      try {
        const root = realpathSync(gitExec(['rev-parse', '--show-toplevel']).trim());
        const realCwd = realpathSync(cwd);
        const pathFromRoot = relative(root, realCwd);
        if (
          pathFromRoot === '..'
          || pathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
          || isAbsolute(pathFromRoot)
        ) {
          errors.push('operation.command.cwd: must remain inside the repository');
        }
      } catch (error) {
        errors.push(`operation.command.cwd: cannot resolve repository path: ${error.message}`);
      }
    }
    if (
      typeof executable === 'string'
      && Array.isArray(args)
      && OPERATION_KINDS.has(input.kind)
      && measuredOperationKind(executable, args) !== input.kind
    ) {
      errors.push('operation.kind: does not match the executable operation class');
    }
    if (
      basename(executable ?? '') === 'gh'
      && Array.isArray(args)
      && args.some((argument, index) =>
        argument === '--input'
          ? args[index + 1] === '-'
          : argument === '--input=-')
    ) {
      errors.push(
        'operation.command.args: stdin payloads are unsupported; use a producer-specific wrapper',
      );
    }
    if (
      typeof executable === 'string'
      && Array.isArray(args)
      && errors.length === 0
    ) {
      const policy = measuredCommandPolicy(input);
      if (policy.block) {
        errors.push(`operation.command: ${policy.reason}`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

function commandStream(value) {
  const text = String(value ?? '');
  return {
    bytes: Buffer.byteLength(text),
    sha256: createHash('sha256').update(text).digest('hex'),
  };
}

function operationIntentMac(value, key) {
  const unsigned = { ...value };
  delete unsigned.mac;
  return createHmac('sha256', Buffer.from(key, 'hex'))
    .update(JSON.stringify(canonical(unsigned)))
    .digest('hex');
}

function operationIntentDirectory(authority, runId, create) {
  const root = join(authority.target, 'operation-intents');
  const run = join(root, runId);
  ensureMeasurementDirectory(root, create);
  return ensureMeasurementDirectory(run, create);
}

function measuredRemoteEffectFingerprint(input) {
  return fingerprint({
    kind: input.kind,
    command: {
      executable: input.command.executable,
      args: input.command.args,
      cwd: realpathSync(input.command.cwd),
    },
  });
}

function validateOperationIntentRecord(value, authority, name, runId) {
  const errors = [];
  if (
    !exactObject(errors, 'intent', value, OPERATION_INTENT_KEYS)
    || value.version !== 1
    || value.state !== 'prepared'
    || value.runId !== runId
    || !NAME_RE.test(value.stageId ?? '')
    || !NAME_RE.test(value.operationId ?? '')
    || !HASH_RE.test(value.inputFingerprint ?? '')
    || !HASH_RE.test(value.effectFingerprint ?? '')
    || !canonicalTimestamp(value.preparedAt)
    || !HASH_RE.test(value.mac ?? '')
    || operationIntentMac(value, authority.key) !== value.mac
  ) {
    throw new Error(`${name}: retained remote mutation intent is invalid`);
  }
  const identity = fingerprint({
    runId: value.runId,
    operationId: value.operationId,
  });
  if (name !== `intent-${identity}.json`) {
    throw new Error(`${name}: remote mutation intent filename does not match its identity`);
  }
  return value;
}

function validateOperationCommitRecord(value, authority, name, runId) {
  const errors = [];
  if (
    !exactObject(errors, 'commit', value, OPERATION_COMMIT_KEYS)
    || value.version !== 1
    || value.state !== 'committed'
    || value.runId !== runId
    || !NAME_RE.test(value.operationId ?? '')
    || !HASH_RE.test(value.inputFingerprint ?? '')
    || !HASH_RE.test(value.effectFingerprint ?? '')
    || !HASH_RE.test(value.eventFingerprint ?? '')
    || !canonicalTimestamp(value.committedAt)
    || !HASH_RE.test(value.mac ?? '')
    || operationIntentMac(value, authority.key) !== value.mac
  ) {
    throw new Error(`${name}: retained remote mutation commit is invalid`);
  }
  const identity = fingerprint({
    runId: value.runId,
    operationId: value.operationId,
  });
  if (name !== `commit-${identity}.json`) {
    throw new Error(`${name}: remote mutation commit filename does not match its identity`);
  }
  return value;
}

function readOperationIntentJournal(authority, runId, create) {
  const directory = operationIntentDirectory(authority, runId, create);
  recoverPublications(directory);
  const names = readdirSync(directory).sort();
  if (names.length > MAX_RUN_EVENTS * 2) {
    throw new Error('remote mutation intent journal exceeds its bounded entry limit');
  }
  const intents = new Map();
  const commits = new Map();
  for (const name of names) {
    const intentMatch = OPERATION_INTENT_FILE_RE.exec(name);
    const commitMatch = OPERATION_COMMIT_FILE_RE.exec(name);
    if (!intentMatch && !commitMatch) {
      throw new Error(`${name}: unexpected remote mutation journal entry`);
    }
    let value;
    try {
      value = JSON.parse(readDescriptor(join(directory, name), MAX_RECORD_BYTES, 0o600));
    } catch (error) {
      throw new Error(`${name}: cannot read remote mutation journal entry: ${error.message}`);
    }
    const record = intentMatch
      ? validateOperationIntentRecord(value, authority, name, runId)
      : validateOperationCommitRecord(value, authority, name, runId);
    const target = intentMatch ? intents : commits;
    if (target.has(record.operationId)) {
      throw new Error(`${name}: duplicate remote mutation journal identity`);
    }
    target.set(record.operationId, { ...record, path: join(directory, name) });
  }
  for (const commit of commits.values()) {
    const intent = intents.get(commit.operationId);
    if (
      intent === undefined
      || intent.inputFingerprint !== commit.inputFingerprint
      || intent.effectFingerprint !== commit.effectFingerprint
    ) {
      throw new Error(
        `${basename(commit.path)}: remote mutation commit does not match its prepared intent`,
      );
    }
  }
  return {
    directory,
    intents,
    commits,
    unresolved: [...intents.values()].filter(
      (intent) => !commits.has(intent.operationId),
    ),
  };
}

function prepareRemoteMutationIntent(input, directory) {
  let target;
  try {
    target = ensureMeasurementDirectory(directory, true);
  } catch (error) {
    return {
      ok: false,
      errors: [`remote mutation intent journal failed: ${error.message}`],
    };
  }
  try {
    return withStoreLock(target, () => {
      const authority = measurementStoreAuthority(target, true);
      const retained = readMeasurementEventsLocked(authority, input.runId);
      if (!retained.ok) throw new Error(retained.errors.join('; '));
      if (retained.events.some((eventValue) =>
        eventValue.kind === 'operation'
        && eventValue.payload.operationId === input.operationId)) {
        return {
          ok: false,
          errors: ['operation.operationId is already retained; refusing duplicate execution'],
        };
      }
      let activeStage = null;
      for (const eventValue of retained.events) {
        if (eventValue.kind === 'stage-start') activeStage = eventValue.payload;
        if (
          eventValue.kind === 'stage-end'
          && eventValue.payload.stageId === activeStage?.id
        ) activeStage = null;
      }
      if (activeStage?.id !== input.stageId) {
        return {
          ok: false,
          errors: ['operation.stageId does not match the retained active stage'],
        };
      }
      const journal = readOperationIntentJournal(authority, input.runId, true);
      if (journal.unresolved.length > 0) {
        return {
          ok: false,
          ambiguous: true,
          errors: [
            'remote mutation journal has an unresolved prepared intent; this run is '
            + 'terminally blocked from every later remote mutation',
          ],
        };
      }
      const identity = fingerprint({
        runId: input.runId,
        operationId: input.operationId,
      });
      const path = join(journal.directory, `intent-${identity}.json`);
      const inputFingerprint = fingerprint(input);
      const effectFingerprint = measuredRemoteEffectFingerprint(input);
      if (journal.intents.has(input.operationId)) {
        return {
          ok: false,
          errors: [
            'operation.operationId already has a retained remote mutation intent',
          ],
        };
      }
      if ([...journal.intents.values()].some(
        (intent) => intent.effectFingerprint === effectFingerprint,
      )) {
        return {
          ok: false,
          errors: [
            'remote mutation effect is already retained; refusing replay under a fresh operationId',
          ],
        };
      }
      const intent = {
        version: 1,
        state: 'prepared',
        runId: input.runId,
        stageId: input.stageId,
        operationId: input.operationId,
        inputFingerprint,
        effectFingerprint,
        preparedAt: new Date().toISOString(),
        mac: '',
      };
      intent.mac = operationIntentMac(intent, authority.key);
      atomicCreate(path, `${JSON.stringify(intent)}\n`, 0o600);
      return {
        ok: true,
        path,
        inputFingerprint,
        effectFingerprint,
      };
    });
  } catch (error) {
    return {
      ok: false,
      errors: [`remote mutation intent journal failed: ${error.message}`],
    };
  }
}

function commitRemoteMutationIntent(input, prepared, eventFingerprint, directory) {
  let target;
  try {
    target = ensureMeasurementDirectory(directory, true);
  } catch (error) {
    return {
      ok: false,
      errors: [`remote mutation commit journal failed: ${error.message}`],
    };
  }
  try {
    return withStoreLock(target, () => {
      const authority = measurementStoreAuthority(target, true);
      const journal = readOperationIntentJournal(authority, input.runId, true);
      const intent = journal.intents.get(input.operationId);
      if (
        intent === undefined
        || intent.path !== prepared.path
        || intent.inputFingerprint !== prepared.inputFingerprint
        || intent.effectFingerprint !== prepared.effectFingerprint
      ) {
        throw new Error('prepared remote mutation intent changed before commit');
      }
      const existing = journal.commits.get(input.operationId);
      if (existing !== undefined) {
        if (existing.eventFingerprint !== eventFingerprint) {
          throw new Error('remote mutation intent has a conflicting commit');
        }
        return { ok: true, path: existing.path, idempotent: true };
      }
      if (!HASH_RE.test(eventFingerprint ?? '')) {
        throw new Error('authenticated operation event fingerprint is invalid');
      }
      const identity = fingerprint({
        runId: input.runId,
        operationId: input.operationId,
      });
      const path = join(journal.directory, `commit-${identity}.json`);
      const commit = {
        version: 1,
        state: 'committed',
        runId: input.runId,
        operationId: input.operationId,
        inputFingerprint: prepared.inputFingerprint,
        effectFingerprint: prepared.effectFingerprint,
        eventFingerprint,
        committedAt: new Date().toISOString(),
        mac: '',
      };
      commit.mac = operationIntentMac(commit, authority.key);
      atomicCreate(path, `${JSON.stringify(commit)}\n`, 0o600);
      return { ok: true, path, idempotent: false };
    });
  } catch (error) {
    return {
      ok: false,
      errors: [`remote mutation commit journal failed: ${error.message}`],
    };
  }
}

function runMeasuredOperation(input, directory, execute = spawnSync) {
  const validation = validMeasuredCommand(input);
  if (!validation.ok) return validation;
  const active = currentMeasurementStage(directory, input.runId);
  if (!active.ok) return active;
  if (active.stage.id !== input.stageId) {
    return {
      ok: false,
      errors: ['operation.stageId does not match the retained active stage'],
    };
  }
  if (active.events.some((eventValue) =>
    eventValue.kind === 'operation'
    && eventValue.payload.operationId === input.operationId)) {
    return {
      ok: false,
      errors: ['operation.operationId is already retained; refusing duplicate execution'],
    };
  }
  let prepared = null;
  if (input.kind === 'remote-mutation') {
    prepared = prepareRemoteMutationIntent(input, directory);
    if (!prepared.ok) return prepared;
  }
  const startedAt = new Date();
  const started = process.hrtime.bigint();
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        key !== 'NODE_OPTIONS'
        && !key.startsWith('AUTOLOOP_AUTHORITY_')
        && !key.startsWith('GIT_')),
    ),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  };
  const result = execute(
    input.command.executable,
    input.command.args,
    {
      cwd: input.command.cwd,
      encoding: 'utf8',
      env,
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      shell: false,
      timeout: 30 * 60 * 1000,
      windowsHide: true,
    },
  );
  const finished = process.hrtime.bigint();
  const finishedAt = new Date();
  const status = result.error
    ? 'launch-failed'
    : typeof result.signal === 'string'
      ? 'signaled'
      : Number.isSafeInteger(result.status)
        ? 'exited'
        : 'launch-failed';
  const evidence = {
    version: 1,
    operationKind: input.kind,
    status,
    executableFingerprint: fingerprint(input.command.executable),
    argumentsFingerprint: fingerprint(input.command.args),
    cwdFingerprint: fingerprint(realpathSync(input.command.cwd)),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: Number((finished - started) / 1_000_000n),
    exitCode: status === 'exited' ? result.status : null,
    signal: status === 'signaled' ? result.signal : null,
    stdout: commandStream(result.stdout),
    stderr: commandStream(result.stderr),
  };
  const capture = captureProducerMeasurementEvent({
    version: 1,
    runId: input.runId,
    kind: 'operation',
    payload: {
      stageId: input.stageId,
      operationId: input.operationId,
      kind: input.kind,
      action: input.action,
    },
    envelopes: {
      evidence: {
        producer: 'command-wrapper',
        type: `${input.kind}-result`,
        subjectId: input.operationId,
        payload: evidence,
      },
    },
  }, directory, 'command-wrapper-observed');
  const commit = input.kind === 'remote-mutation' && capture.ok
    ? commitRemoteMutationIntent(
      input,
      prepared,
      capture.contentFingerprint,
      directory,
    )
    : null;
  return {
    ok: capture.ok
      && (commit === null || commit.ok)
      && status === 'exited'
      && result.status === 0,
    capture,
    ...(commit === null ? {} : { commit }),
    ...(input.kind === 'remote-mutation' && (!capture.ok || !commit?.ok)
      ? {
          ambiguous: true,
          errors: [
            'remote mutation did not reach its authenticated commit marker; '
            + 'this run is terminally blocked',
            ...(capture.errors ?? []),
            ...(commit?.errors ?? []),
          ],
        }
      : {}),
    command: {
      status,
      exitCode: evidence.exitCode,
      signal: evidence.signal,
      error: result.error?.message ?? null,
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
      retrySafe: input.kind !== 'remote-mutation',
    },
  };
}

function producerMeasurementDirectory(repositoryRoot) {
  const root = realpathSync(repositoryRoot);
  const activeRoot = realpathSync(
    gitExec(['rev-parse', '--show-toplevel']).trim(),
  );
  if (root !== activeRoot || resolve(repositoryRoot) !== root) {
    throw new Error('producer repository root is not the active exact checkout');
  }
  return measurementDirectory();
}

function validateRuntimeMeasurementBindingInput(input) {
  const errors = [];
  if (!exactObject(
    errors,
    'binding',
    input,
    RUNTIME_MEASUREMENT_BINDING_KEYS,
  )) return { ok: false, errors };
  const declaration = input.measurement;
  if (!exactObject(
    errors,
    'binding.measurement',
    declaration,
    RUNTIME_MEASUREMENT_DECLARATION_KEYS,
  )) return { ok: false, errors };
  if (declaration.version !== 1) errors.push('binding.measurement.version: expected 1');
  if (!UUID_RE.test(declaration.runId ?? '')) {
    errors.push('binding.measurement.runId: expected UUID v4');
  }
  if (!NAME_RE.test(declaration.workload ?? '')) {
    errors.push('binding.measurement.workload: invalid identifier');
  }
  requireEnum(
    errors,
    'binding.measurement.checkpoint',
    declaration.checkpoint,
    CHECKPOINTS,
  );
  for (const key of [
    'comparisonContextFingerprint',
    'checkpointEndpointFingerprint',
  ]) {
    if (!HASH_RE.test(declaration[key] ?? '')) {
      errors.push(`binding.measurement.${key}: expected sha256`);
    }
  }
  requireEnum(
    errors,
    'binding.measurement.intentSource',
    declaration.intentSource,
    INTENT_SOURCES,
  );
  if (declaration.intentProvenance !== INTENT_PROVENANCE) {
    errors.push(
      `binding.measurement.intentProvenance: expected ${INTENT_PROVENANCE}`,
    );
  }
  requireEnum(
    errors,
    'binding.measurement.mergePolicy',
    declaration.mergePolicy,
    MERGE_POLICIES,
  );
  requireEnum(
    errors,
    'binding.measurement.baseFreshnessStrategy',
    declaration.baseFreshnessStrategy,
    BASE_STRATEGIES,
  );
  if (
    !validateRuntimeRun(input.run)
    || !FLOWS.has(input.run?.invocationFlow)
    || input.run?.intentProvenance !== declaration.intentProvenance
    || (
      (input.run.generation > 0) !== (declaration.intentSource === 'relaunch')
      && declaration.intentSource !== 'orphan-recovery'
    )
  ) {
    errors.push('binding: Runtime run or intent source is invalid');
  }
  return { ok: errors.length === 0, errors };
}

function runtimeStartCaptureInput(input) {
  const { measurement, run } = input;
  return {
    version: 1,
    runId: measurement.runId,
    kind: 'run-start',
    payload: {
      workload: measurement.workload,
      checkpoint: measurement.checkpoint,
      comparisonContextFingerprint: measurement.comparisonContextFingerprint,
      checkpointEndpointFingerprint: measurement.checkpointEndpointFingerprint,
      activeHost: run.activeHost,
      selector: run.selector,
      requestedEngine: run.requestedEngine,
      requestedRoute: run.requestedRoute,
      intentProvenance: run.intentProvenance,
      intent: {
        flow: run.invocationFlow,
        source: measurement.intentSource,
      },
      mergePolicy: measurement.mergePolicy,
      baseFreshnessStrategy: measurement.baseFreshnessStrategy,
      configFingerprint: run.configFingerprint,
    },
    envelopes: {
      runtimeBinding: {
        producer: 'runtime',
        type: 'run-context',
        subjectId: run.instanceFingerprint,
        payload: {
          run: structuredClone(run),
        },
      },
    },
  };
}

export function bindRuntimeMeasurement(input, repositoryRoot) {
  const validation = validateRuntimeMeasurementBindingInput(input);
  if (!validation.ok) return validation;
  let directory;
  try {
    directory = producerMeasurementDirectory(repositoryRoot);
  } catch (error) {
    return { ok: false, errors: [`Runtime measurement binding failed: ${error.message}`] };
  }
  const captureInput = runtimeStartCaptureInput(input);
  const built = buildProducerMeasurementEvent(captureInput);
  if (!built.ok) return built;
  const existing = readMeasurementEvents(directory, input.measurement.runId);
  if (!existing.ok) return existing;
  if (existing.events.length > 0) {
    const first = existing.events[0];
    if (
      first.kind !== 'run-start'
      || !sameValue(first.payload, built.event.payload)
    ) {
      return {
        ok: false,
        errors: ['measurement run ID is already bound to different Runtime evidence'],
      };
    }
    return {
      ok: true,
      value: {
        runId: input.measurement.runId,
        runInstanceFingerprint: input.run.instanceFingerprint,
        idempotent: true,
        path: null,
        contentFingerprint: first.provenance.contentFingerprint,
      },
    };
  }
  const captured = captureProducerMeasurementEvent(
    captureInput,
    directory,
    'runtime-authority-verified',
  );
  if (!captured.ok) return captured;
  return {
    ok: true,
    value: {
      runId: input.measurement.runId,
      runInstanceFingerprint: input.run.instanceFingerprint,
      idempotent: false,
      path: captured.path,
      contentFingerprint: captured.contentFingerprint,
    },
  };
}

function validateRuntimeMeasurementUnitBindingInput(input) {
  const errors = [];
  if (!exactObject(
    errors,
    'binding',
    input,
    RUNTIME_MEASUREMENT_UNIT_BINDING_KEYS,
  )) return { ok: false, errors };
  if (!UUID_RE.test(input.runId ?? '')) {
    errors.push('binding.runId: expected UUID v4');
  }
  if (!NAME_RE.test(input.unitId ?? '')) {
    errors.push('binding.unitId: invalid identifier');
  }
  if (
    !validateRuntimeRun(input.run)
    || !validateRuntimePlan(input.plan, input.run)
  ) {
    errors.push('binding: Runtime run or plan is invalid');
  }
  return { ok: errors.length === 0, errors };
}

function runtimeUnitContextCaptureInput(input) {
  return {
    version: 1,
    runId: input.runId,
    kind: 'unit-context',
    payload: {
      unitId: input.unitId,
      initialLane: input.plan.effectiveLane,
      initialLaneProofFingerprint: input.plan.laneProofFingerprint,
      planFingerprint: input.plan.fingerprint,
      capabilityFingerprint: input.plan.capabilityFingerprint,
      outageFingerprint: input.plan.routeState.fingerprint,
    },
    envelopes: {},
  };
}

export function bindRuntimeMeasurementUnit(input, repositoryRoot) {
  const validation = validateRuntimeMeasurementUnitBindingInput(input);
  if (!validation.ok) return validation;
  let directory;
  try {
    directory = producerMeasurementDirectory(repositoryRoot);
  } catch (error) {
    return {
      ok: false,
      errors: [`Runtime measurement unit binding failed: ${error.message}`],
    };
  }
  const retained = readMeasurementEvents(directory, input.runId);
  if (!retained.ok || retained.events.length === 0) {
    return retained.ok
      ? { ok: false, errors: ['measurement unit has no bound Runtime run'] }
      : retained;
  }
  const first = retained.events[0];
  const binding = first.payload?.runtimeBinding?.envelope?.payload;
  const boundRun = binding?.run;
  if (
    first.kind !== 'run-start'
    || first.payload?.runtimeBinding?.status !== 'observed'
    || !plainObject(binding)
    || Object.keys(binding).sort().join(',') !== 'run'
    || !sameValue(boundRun, input.run)
  ) {
    return {
      ok: false,
      errors: ['measurement unit does not match its bound Runtime run'],
    };
  }
  const captureInput = runtimeUnitContextCaptureInput(input);
  const built = buildProducerMeasurementEvent(captureInput);
  if (!built.ok) return built;
  const contexts = retained.events.filter((eventValue) =>
    eventValue.kind === 'unit-context');
  if (contexts.length > 0) {
    if (
      contexts.length !== 1
      || !sameValue(contexts[0].payload, built.event.payload)
    ) {
      return {
        ok: false,
        errors: ['measurement unit is already bound to different Runtime evidence'],
      };
    }
    return {
      ok: true,
      value: {
        runId: input.runId,
        runInstanceFingerprint: input.run.instanceFingerprint,
        unitId: input.unitId,
        lane: input.plan.effectiveLane,
        laneProofFingerprint: input.plan.laneProofFingerprint,
        planFingerprint: input.plan.fingerprint,
        idempotent: true,
        path: null,
        contentFingerprint: contexts[0].provenance.contentFingerprint,
      },
    };
  }
  let activeStage = null;
  let selectionCount = 0;
  for (const eventValue of retained.events.slice(1)) {
    if (eventValue.kind === 'run-finish') {
      return { ok: false, errors: ['measurement run is already finished'] };
    }
    if (eventValue.kind === 'dispatch') {
      return {
        ok: false,
        errors: ['measurement unit must bind before its first Runtime dispatch'],
      };
    }
    if (eventValue.kind === 'stage-start') {
      activeStage = eventValue.payload.id;
    }
    if (eventValue.kind === 'stage-end') {
      if (eventValue.payload.stageId === activeStage) activeStage = null;
      const started = retained.events.find((candidate) =>
        candidate.kind === 'stage-start'
        && candidate.payload.id === eventValue.payload.stageId);
      if (started?.payload.stage === 'selection') selectionCount += 1;
    }
  }
  if (activeStage !== null) {
    return {
      ok: false,
      errors: ['measurement unit must bind between completed stage boundaries'],
    };
  }
  if (selectionCount !== 1) {
    return {
      ok: false,
      errors: ['measurement unit requires exactly one completed selection stage'],
    };
  }
  const captured = captureProducerMeasurementEvent(
    captureInput,
    directory,
    'runtime-authority-verified',
  );
  if (!captured.ok) return captured;
  return {
    ok: true,
    value: {
      runId: input.runId,
      runInstanceFingerprint: input.run.instanceFingerprint,
      unitId: input.unitId,
      lane: input.plan.effectiveLane,
      laneProofFingerprint: input.plan.laneProofFingerprint,
      planFingerprint: input.plan.fingerprint,
      idempotent: false,
      path: captured.path,
      contentFingerprint: captured.contentFingerprint,
    },
  };
}

function unavailableRuntimeTelemetry(reason) {
  return Object.fromEntries(
    SEGMENT_TELEMETRY_KEYS.map((key) => [key, unavailable(reason)]),
  );
}

function runtimeDegradation(receipt) {
  if (receipt.degradation.length === 0) return null;
  return {
    code: [...receipt.degradation].sort().join('+'),
    reason: 'Runtime reported a bounded route degradation.',
  };
}

function runtimeDispatchCaptureInput(runId, stage, receipt) {
  const facts = runtimeReviewFacts(receipt);
  if (facts === null) return null;
  return {
    version: 1,
    runId,
    kind: 'dispatch',
    payload: {
      stageId: stage.id,
      dispatchId: receipt.fingerprint,
      findings: facts.findings,
      rebuts: facts.rebuts,
    },
    envelopes: {
      runtimeReceipt: {
        producer: 'runtime',
        type: 'runtime-receipt',
        subjectId: receipt.fingerprint,
        payload: structuredClone(receipt),
      },
    },
  };
}

function runtimeStageEndCaptureInput(runId, stage, receipt) {
  const reason = 'provider accounting is unavailable from the selected adapter';
  return {
    version: 1,
    runId,
    kind: 'stage-end',
    payload: {
      stageId: stage.id,
      actualRoute: receipt.actualRoute,
      adapter: receipt.adapter,
      degradation: runtimeDegradation(receipt),
      telemetry: unavailableRuntimeTelemetry(reason),
    },
    envelopes: {
      providerEvidence: {
        status: 'unavailable',
        reason,
      },
    },
  };
}

function matchingRetainedEvent(events, kind, identity, expected) {
  const matches = events.filter((eventValue) =>
    eventValue.kind === kind
    && (kind === 'dispatch'
      ? eventValue.payload.dispatchId === identity
      : eventValue.payload.stageId === identity));
  if (matches.length === 0) return { exists: false, matches: true, event: null };
  return {
    exists: true,
    matches: matches.length === 1
      && sameValue(matches[0].payload, expected.payload),
    event: matches[0],
  };
}

function captureRuntimeDispatchMeasurementAt(input, directory) {
  if (
    !plainObject(input)
    || Object.keys(input).sort().join(',') !== 'receipt,runId'
    || !UUID_RE.test(input.runId ?? '')
    || !validateRuntimeReceipt(input.receipt)
  ) {
    return { ok: false, errors: ['Runtime dispatch measurement input is invalid'] };
  }
  const retained = readMeasurementEvents(directory, input.runId);
  if (!retained.ok || retained.events.length === 0) {
    return retained.ok
      ? { ok: false, errors: ['Runtime dispatch has no bound measurement run'] }
      : retained;
  }
  const start = retained.events[0];
  const binding = start.payload.runtimeBinding?.envelope?.payload;
  const unitContexts = retained.events.filter((eventValue) =>
    eventValue.kind === 'unit-context');
  const unitContext = unitContexts.length === 1
    ? unitContexts[0].payload
    : null;
  if (
    start.kind !== 'run-start'
    || start.payload.runtimeBinding?.status !== 'observed'
    || input.receipt.runInstanceFingerprint !== binding?.run?.instanceFingerprint
    || input.receipt.configFingerprint !== start.payload.configFingerprint
    || input.receipt.activeHost !== start.payload.activeHost
    || input.receipt.selector !== start.payload.selector
    || input.receipt.requestedEngine !== start.payload.requestedEngine
    || input.receipt.requestedRoute !== start.payload.requestedRoute
    || input.receipt.intentProvenance !== start.payload.intentProvenance
    || unitContext === null
    || input.receipt.capabilityFingerprint !== unitContext.capabilityFingerprint
    || input.receipt.attempts[0].planFingerprint
      !== unitContext.planFingerprint
  ) {
    return {
      ok: false,
      errors: ['Runtime receipt does not match the measurement run binding'],
    };
  }
  let stage = null;
  for (const eventValue of retained.events) {
    if (eventValue.kind === 'stage-start') stage = eventValue.payload;
    if (eventValue.kind === 'stage-end' && stage?.id === eventValue.payload.stageId) {
      stage = null;
    }
  }
  const priorDispatch = retained.events.find((eventValue) =>
    eventValue.kind === 'dispatch'
    && eventValue.payload.dispatchId === input.receipt.fingerprint);
  const boundStage = stage ?? (
    priorDispatch
      ? retained.events.find((eventValue) =>
          eventValue.kind === 'stage-start'
          && eventValue.payload.id === priorDispatch.payload.stageId)?.payload
      : null
  );
  if (
    !boundStage
    || boundStage.stage !== input.receipt.stage
    || boundStage.round !== input.receipt.round
  ) {
    return {
      ok: false,
      errors: ['Runtime receipt does not match the retained measurement stage'],
    };
  }
  const dispatchInput = runtimeDispatchCaptureInput(
    input.runId,
    boundStage,
    input.receipt,
  );
  if (dispatchInput === null) {
    return { ok: false, errors: ['Runtime review receipt is invalid'] };
  }
  const builtDispatch = buildProducerMeasurementEvent(dispatchInput);
  if (!builtDispatch.ok) return builtDispatch;
  const stageEndInput = runtimeStageEndCaptureInput(
    input.runId,
    boundStage,
    input.receipt,
  );
  const builtStageEnd = buildProducerMeasurementEvent(stageEndInput);
  if (!builtStageEnd.ok) return builtStageEnd;
  const existingDispatch = matchingRetainedEvent(
    retained.events,
    'dispatch',
    input.receipt.fingerprint,
    builtDispatch.event,
  );
  const existingStageEnd = matchingRetainedEvent(
    retained.events,
    'stage-end',
    boundStage.id,
    builtStageEnd.event,
  );
  if (!existingDispatch.matches || !existingStageEnd.matches) {
    return {
      ok: false,
      errors: ['retained Runtime measurement event conflicts with this receipt'],
    };
  }
  let dispatch = existingDispatch.event;
  if (!existingDispatch.exists) {
    const captured = captureProducerMeasurementEvent(
      dispatchInput,
      directory,
      'runtime-authority-verified',
    );
    if (!captured.ok) return captured;
    dispatch = captured;
  }
  let stageEnd = existingStageEnd.event;
  if (!existingStageEnd.exists) {
    const captured = captureProducerMeasurementEvent(
      stageEndInput,
      directory,
      'runtime-authority-verified',
    );
    if (!captured.ok) return captured;
    stageEnd = captured;
  }
  return {
    ok: true,
    value: {
      runId: input.runId,
      dispatchId: input.receipt.fingerprint,
      idempotent: existingDispatch.exists && existingStageEnd.exists,
      dispatch,
      stageEnd,
    },
  };
}

export function captureRuntimeDispatchMeasurement(input, repositoryRoot) {
  let directory;
  try {
    directory = producerMeasurementDirectory(repositoryRoot);
  } catch (error) {
    return { ok: false, errors: [`Runtime dispatch capture failed: ${error.message}`] };
  }
  return captureRuntimeDispatchMeasurementAt(input, directory);
}

function eventContent(eventValue) {
  const copy = { ...eventValue };
  delete copy.provenance;
  return copy;
}

function eventContentFingerprint(eventValue) {
  return fingerprint(eventContent(eventValue));
}

function validateMeasurementEventRecord(eventValue) {
  const graph = validateDataGraph(eventValue);
  if (!graph.ok) return graph;
  const errors = [];
  if (!exactObject(errors, 'eventRecord', eventValue, EVENT_RECORD_KEYS)) {
    return { ok: false, errors };
  }
  const input = Object.fromEntries(
    EVENT_INPUT_KEYS.map((key) => [key, eventValue[key]]),
  );
  errors.push(...validateMeasurementEventInput(input).errors);
  if (!UUID_RE.test(eventValue.eventId ?? '')) {
    errors.push('eventRecord.eventId: expected UUID v4');
  }
  if (
    !Number.isSafeInteger(eventValue.sequence)
    || eventValue.sequence < 0
    || eventValue.sequence >= MAX_RUN_EVENTS
  ) {
    errors.push('eventRecord.sequence: expected bounded non-negative integer');
  }
  if (!canonicalTimestamp(eventValue.capturedAt)) {
    errors.push('eventRecord.capturedAt: expected canonical UTC timestamp');
  }
  if (!SHA_RE.test(eventValue.revision ?? '')) {
    errors.push('eventRecord.revision: expected commit OID');
  }
  if (
    exactObject(
      errors,
      'eventRecord.provenance',
      eventValue.provenance,
      EVENT_PROVENANCE_KEYS,
    )
  ) {
    if (eventValue.provenance.kind !== 'tool-authenticated-event') {
      errors.push('eventRecord.provenance.kind: expected tool-authenticated-event');
    }
    if (!UUID_RE.test(eventValue.provenance.storeId ?? '')) {
      errors.push('eventRecord.provenance.storeId: expected UUID v4');
    }
    if (!HASH_RE.test(eventValue.provenance.contentFingerprint ?? '')) {
      errors.push('eventRecord.provenance.contentFingerprint: expected sha256');
    } else if (
      eventValue.provenance.contentFingerprint !== eventContentFingerprint(eventValue)
    ) {
      errors.push('eventRecord.provenance.contentFingerprint: event content changed');
    }
    if (exactObject(
      errors,
      'eventRecord.provenance.capture',
      eventValue.provenance.capture,
      EVENT_CAPTURE_KEYS,
    )) {
      if (eventValue.provenance.capture.revisionSource !== 'live-git-head') {
        errors.push('eventRecord.provenance.capture.revisionSource: expected live-git-head');
      }
      if (eventValue.provenance.capture.timeSource !== 'tool-clock') {
        errors.push('eventRecord.provenance.capture.timeSource: expected tool-clock');
      }
      requireEnum(
        errors,
        'eventRecord.provenance.capture.payloadSource',
        eventValue.provenance.capture.payloadSource,
        EVENT_PAYLOAD_SOURCES,
      );
      requireNumber(
        errors,
        'eventRecord.provenance.capture.durationMs',
        eventValue.provenance.capture.durationMs,
        true,
      );
    }
    if (!HASH_RE.test(eventValue.provenance.mac ?? '')) {
      errors.push('eventRecord.provenance.mac: expected sha256 HMAC');
    }
  }
  return { ok: errors.length === 0, errors };
}

function eventSetDerivation(events) {
  return {
    pipelineVersion: MEASUREMENT_EVENT_VERSION,
    runId: events[0]?.runId,
    startRevision: events[0]?.revision,
    eventCount: events.length,
    eventSetFingerprint: fingerprint(events.map((eventValue) => ({
      sequence: eventValue.sequence,
      eventId: eventValue.eventId,
      contentFingerprint: eventValue.provenance.contentFingerprint,
      mac: eventValue.provenance.mac,
    }))),
  };
}

function derivedUnavailable(reason) {
  return { status: 'unavailable', reason };
}

function aggregateDerivedTelemetry(segments, key) {
  const values = segments.map((segment) => observationValue(segment.telemetry[key]));
  if (values.every((value) => value !== null)) {
    return { status: 'observed', value: values.reduce((sum, value) => sum + value, 0) };
  }
  return derivedUnavailable(`one or more authenticated stage events lack ${key}`);
}

function policySafeEventError(message) {
  return { ok: false, errors: [message] };
}

export function deriveMeasurementFromEvents(events, recordId) {
  if (
    !Array.isArray(events)
    || events.length < 2
    || events.length > MAX_RUN_EVENTS
    || !UUID_RE.test(recordId ?? '')
  ) {
    return policySafeEventError(
      'event derivation requires a record UUID and a bounded event sequence',
    );
  }
  const validations = events.map(validateMeasurementEventRecord);
  if (validations.some((validation) => !validation.ok)) {
    return {
      ok: false,
      errors: validations.flatMap((validation, index) =>
        validation.errors.map((error) => `events[${index}]: ${error}`)),
    };
  }
  if (events.some((eventValue) => !TRUSTED_EVENTS.has(eventValue))) {
    return policySafeEventError(
      'event derivation requires authenticated records loaded from the local event store',
    );
  }
  const runId = events[0].runId;
  for (const [index, eventValue] of events.entries()) {
    if (eventValue.sequence !== index) {
      return policySafeEventError('event sequence has a gap, duplicate, or reordering');
    }
    if (eventValue.runId !== runId) {
      return policySafeEventError('event sequence mixes run identities');
    }
    if (
      index > 0
      && Date.parse(eventValue.capturedAt) < Date.parse(events[index - 1].capturedAt)
    ) {
      return policySafeEventError('event capture times are not monotonic');
    }
  }
  if (events[0].kind !== 'run-start' || events.at(-1).kind !== 'run-finish') {
    return policySafeEventError('event sequence must start and finish exactly once');
  }
  if (
    events.slice(1).some((eventValue) => eventValue.kind === 'run-start')
    || events.slice(0, -1).some((eventValue) => eventValue.kind === 'run-finish')
  ) {
    return policySafeEventError('run boundary events are duplicated or out of order');
  }

  const start = events[0];
  const finish = events.at(-1);
  if (start.payload.checkpoint === 'legacy-workflow') {
    return policySafeEventError(
      'legacy workflow events have no authenticated import path',
    );
  }
  if (start.payload.runtimeBinding.status !== 'observed') {
    return policySafeEventError(
      'run start requires an observed broker-authorized Runtime binding',
    );
  }
  const runtimeRunFingerprint =
    start.payload.runtimeBinding.envelope.payload.run.instanceFingerprint;
  const base = {
    version: MEASUREMENT_VERSION,
    recordId,
    capturedAt: finish.capturedAt,
    revision: finish.revision,
    workload: start.payload.workload,
    checkpoint: start.payload.checkpoint,
    comparisonContextFingerprint: start.payload.comparisonContextFingerprint,
    checkpointEndpointFingerprint: start.payload.checkpointEndpointFingerprint,
    activeHost: start.payload.activeHost,
    selector: start.payload.selector,
    requestedEngine: start.payload.requestedEngine,
    requestedRoute: start.payload.requestedRoute,
    intentProvenance: start.payload.intentProvenance,
    intent: structuredClone(start.payload.intent),
    mergePolicy: start.payload.mergePolicy,
    baseFreshnessStrategy: start.payload.baseFreshnessStrategy,
    configFingerprint: start.payload.configFingerprint,
    capabilityFingerprint: null,
    outageFingerprint: null,
  };
  const segments = [];
  const stageIds = new Set();
  const operationIds = new Set();
  const dispatchIds = new Set();
  const findingIds = new Set();
  const rebuttedFindingIds = new Set();
  const lifecycleIds = new Set();
  const lifecycle = new Map(
    [...LIFECYCLE_EVENT_KINDS].map((kind) => [kind, new Set()]),
  );
  const operationCounts = {
    'github-api': 0,
    subprocess: 0,
    'remote-mutation': 0,
  };
  const findings = { critical: 0, major: 0, minor: 0 };
  const rebuts = { accepted: 0, rejected: 0 };
  const outageTransitions = [];
  let unitContext = null;
  let currentStage = null;
  let currentWait = null;
  let selectionCompletedAtMs = null;

  for (const eventValue of events.slice(1, -1)) {
    const payload = eventValue.payload;
    if (eventValue.kind === 'unit-context') {
      if (
        unitContext !== null
        || currentStage !== null
        || currentWait !== null
        || selectionCompletedAtMs === null
      ) {
        return policySafeEventError(
          'unit context must occur exactly once after selection and between stage boundaries',
        );
      }
      unitContext = structuredClone(payload);
      base.capabilityFingerprint = unitContext.capabilityFingerprint;
      base.outageFingerprint = unitContext.outageFingerprint;
      for (const segment of segments) {
        segment.effectiveLane = unitContext.initialLane;
        segment.laneProofFingerprint = unitContext.initialLaneProofFingerprint;
      }
      continue;
    }
    if (eventValue.kind === 'stage-start') {
      if (
        currentStage !== null
        || stageIds.has(payload.id)
        || (
          ['plan-review', 'claim', 'implementation', 'simplify', 'diff-review',
            'code-review', 'judgment-review', 'gate', 'delivery'].includes(payload.stage)
          && unitContext === null
        )
      ) {
        return policySafeEventError('stage boundaries overlap or reuse an identity');
      }
      stageIds.add(payload.id);
      currentStage = {
        id: payload.id,
        stage: payload.stage,
        round: payload.round,
        startedAtMs: Date.parse(eventValue.capturedAt),
        waits: { engine: 0, ci: 0, human: 0 },
        dispatch: null,
      };
      continue;
    }
    if (eventValue.kind === 'wait-start') {
      if (
        currentStage === null
        || currentWait !== null
        || payload.stageId !== currentStage.id
      ) {
        return policySafeEventError('wait start is outside its unique active stage');
      }
      currentWait = {
        id: payload.waitId,
        category: payload.category,
        startedAtMs: Date.parse(eventValue.capturedAt),
      };
      continue;
    }
    if (eventValue.kind === 'wait-end') {
      if (
        currentStage === null
        || currentWait === null
        || payload.stageId !== currentStage.id
        || payload.waitId !== currentWait.id
        || payload.category !== currentWait.category
      ) {
        return policySafeEventError('wait end does not match the active wait');
      }
      currentStage.waits[currentWait.category] +=
        Date.parse(eventValue.capturedAt) - currentWait.startedAtMs;
      currentWait = null;
      continue;
    }
    if (eventValue.kind === 'operation') {
      if (
        currentStage === null
        || payload.stageId !== currentStage.id
        || operationIds.has(payload.operationId)
      ) {
        return policySafeEventError('operation identity is replayed or outside its stage');
      }
      if (payload.evidence.status !== 'observed') {
        return policySafeEventError(
          'unavailable operation evidence is retained but cannot become an aggregate count',
        );
      }
      operationIds.add(payload.operationId);
      operationCounts[payload.kind] += 1;
      continue;
    }
    if (eventValue.kind === 'dispatch') {
      if (
        currentStage === null
        || payload.stageId !== currentStage.id
        || !DISPATCH_STAGES.has(currentStage.stage)
        || currentStage.dispatch !== null
        || dispatchIds.has(payload.dispatchId)
      ) {
        return policySafeEventError('dispatch is replayed or outside its dispatch stage');
      }
      if (payload.runtimeReceipt.status !== 'observed') {
        return policySafeEventError('dispatch Runtime receipt is unavailable');
      }
      const receipt = payload.runtimeReceipt.envelope.payload;
      if (
        receipt.runInstanceFingerprint !== runtimeRunFingerprint
        || receipt.configFingerprint !== base.configFingerprint
        || receipt.activeHost !== base.activeHost
        || receipt.selector !== base.selector
        || receipt.requestedEngine !== base.requestedEngine
        || receipt.requestedRoute !== base.requestedRoute
        || receipt.intentProvenance !== base.intentProvenance
        || receipt.capabilityFingerprint !== base.capabilityFingerprint
        || unitContext === null
        || receipt.stage !== currentStage.stage
        || receipt.round !== currentStage.round
      ) {
        return policySafeEventError(
          'dispatch Runtime receipt does not match the bound run or active stage',
        );
      }
      for (const finding of payload.findings) {
        if (findingIds.has(finding.id)) {
          return policySafeEventError('dispatch finding identity is duplicated');
        }
        findingIds.add(finding.id);
        findings[finding.severity] += 1;
      }
      for (const rebut of payload.rebuts) {
        if (
          !findingIds.has(rebut.findingId)
          || rebuttedFindingIds.has(rebut.findingId)
        ) {
          return policySafeEventError('rebut identity is missing, duplicated, or out of order');
        }
        rebuttedFindingIds.add(rebut.findingId);
        rebuts[rebut.disposition] += 1;
      }
      dispatchIds.add(payload.dispatchId);
      if (receipt.outageTransition !== 'none') {
        outageTransitions.push(receipt.outageTransition);
      }
      currentStage.dispatch = {
        id: payload.dispatchId,
        actualRoute: receipt.actualRoute,
        adapter: receipt.adapter,
        effectiveLane: receipt.effectiveLane,
        laneProofFingerprint: receipt.laneProofFingerprint,
      };
      continue;
    }
    if (eventValue.kind === 'stage-end') {
      if (
        currentStage === null
        || currentWait !== null
        || payload.stageId !== currentStage.id
      ) {
        return policySafeEventError('stage end does not match the active stage');
      }
      if (
        DISPATCH_STAGES.has(currentStage.stage) !== (currentStage.dispatch !== null)
      ) {
        return policySafeEventError('dispatch-stage receipt is missing or unexpected');
      }
      if (
        currentStage.dispatch !== null
        && (
          currentStage.dispatch.actualRoute !== payload.actualRoute
          || currentStage.dispatch.adapter !== payload.adapter
        )
      ) {
        return policySafeEventError(
          'stage result does not match its authenticated Runtime route receipt',
        );
      }
      const totalMs = Date.parse(eventValue.capturedAt) - currentStage.startedAtMs;
      const engineWaitMs = currentStage.waits.engine;
      const ciWaitMs = currentStage.waits.ci;
      const humanWaitMs = currentStage.waits.human;
      const activeMs = totalMs - engineWaitMs - ciWaitMs - humanWaitMs;
      if (activeMs < 0) {
        return policySafeEventError('stage wait intervals exceed the stage boundary');
      }
      const segment = {
        id: currentStage.id,
        stage: currentStage.stage,
        round: currentStage.round,
        role: expectedRole(currentStage.stage),
        effectiveLane:
          currentStage.dispatch?.effectiveLane ?? unitContext?.initialLane ?? 'full',
        laneProofFingerprint:
          currentStage.dispatch?.laneProofFingerprint
          ?? unitContext?.initialLaneProofFingerprint
          ?? null,
        requestedRoute: expectedSegmentRoute(
          base,
          {
            ...currentStage,
            effectiveLane:
              currentStage.dispatch?.effectiveLane ?? unitContext?.initialLane ?? 'full',
          },
        ),
        actualRoute: payload.actualRoute,
        adapter: payload.adapter,
        degradation: structuredClone(payload.degradation),
        timing: {
          totalMs,
          activeMs,
          engineWaitMs,
          ciWaitMs,
          humanWaitMs,
          steps: { execute: activeMs },
        },
        telemetry: structuredClone(payload.telemetry),
      };
      segments.push(segment);
      if (currentStage.stage === 'selection') {
        if (selectionCompletedAtMs !== null) {
          return policySafeEventError('selection stage is duplicated');
        }
        selectionCompletedAtMs = Date.parse(eventValue.capturedAt);
      }
      currentStage = null;
      continue;
    }
    if (eventValue.kind === 'lifecycle') {
      if (payload.evidence.status !== 'observed') {
        return policySafeEventError(
          'unavailable lifecycle evidence is retained but cannot become an aggregate count',
        );
      }
      const identity = `${payload.kind}:${payload.subjectId}`;
      if (lifecycleIds.has(identity)) {
        return policySafeEventError('lifecycle evidence identity is replayed');
      }
      lifecycleIds.add(identity);
      lifecycle.get(payload.kind).add(payload.subjectId);
      continue;
    }
    return policySafeEventError(`event ${eventValue.kind} is out of order`);
  }
  if (
    currentStage !== null
    || currentWait !== null
    || unitContext === null
    || selectionCompletedAtMs === null
    || segments.length === 0
  ) {
    return policySafeEventError('event sequence ends with an incomplete stage or no stages');
  }
  if (finish.payload.terminalEvidence.status !== 'observed') {
    return policySafeEventError(
      'terminal evidence is retained as unavailable but cannot finalize an observation identity',
    );
  }
  if (
    finish.payload.terminal.status === 'completed'
    && (
      finish.payload.gateEvidence.status !== 'observed'
      || finish.payload.lifecycleEvidence.status !== 'observed'
    )
  ) {
    return policySafeEventError(
      'completed run requires observed gate and lifecycle evidence envelopes',
    );
  }
  const stagedAhead = lifecycle.get('staged-ahead');
  const utilized = lifecycle.get('utilized-staged-unit');
  if ([...utilized].some((subjectId) => !stagedAhead.has(subjectId))) {
    return policySafeEventError('utilized staged units require prior staged-ahead evidence');
  }

  const totalMs = Date.parse(finish.capturedAt) - Date.parse(start.capturedAt);
  const engineWaitMs = segments.reduce((sum, segment) => sum + segment.timing.engineWaitMs, 0);
  const ciWaitMs = segments.reduce((sum, segment) => sum + segment.timing.ciWaitMs, 0);
  const humanWaitMs = segments.reduce((sum, segment) => sum + segment.timing.humanWaitMs, 0);
  const activeMs = totalMs - engineWaitMs - ciWaitMs - humanWaitMs;
  const segmentDuration = segments.reduce((sum, segment) => sum + segment.timing.totalMs, 0);
  const instrumentationDuration = events.reduce(
    (sum, eventValue) => sum + eventValue.provenance.capture.durationMs,
    0,
  );
  if (
    totalMs < 0
    || activeMs < 0
    || segmentDuration > totalMs
  ) {
    return policySafeEventError('run timing cannot reconcile authenticated event boundaries');
  }
  const selectionCount = segments.filter((segment) =>
    segment.stage === 'selection').length;
  if (selectionCount !== 1) {
    return policySafeEventError('event sequence requires exactly one selection stage');
  }
  const timeToFirstSelectionMs =
    selectionCompletedAtMs - Date.parse(start.capturedAt);
  if (timeToFirstSelectionMs < 0) {
    return policySafeEventError('selection completion precedes the run start');
  }
  const telemetry = Object.fromEntries(
    UNIT_TELEMETRY_KEYS.map((key) => [key, aggregateDerivedTelemetry(segments, key)]),
  );
  const dispatchSegments = segments.filter((segment) => DISPATCH_STAGES.has(segment.stage));
  const recordValue = {
    ...base,
    lane: unitContext.initialLane,
    outageTransition:
      outageTransitions.length === 0
        ? null
        : outageTransitions.join('>'),
    instrumentationOverhead: {
      durationMs: instrumentationDuration,
      githubApi: 0,
      subprocesses: events.length,
      remoteMutations: 0,
    },
    segments,
    unit: {
      timing: {
        timeToFirstSelectionMs,
        totalMs,
        activeMs,
        engineWaitMs,
        ciWaitMs,
        humanWaitMs,
        steps: { selection: timeToFirstSelectionMs },
      },
      telemetry,
      calls: {
        githubApi: operationCounts['github-api'],
        subprocesses: operationCounts.subprocess + events.length,
        remoteMutations: operationCounts['remote-mutation'],
      },
      dispatch: {
        count: dispatchSegments.length,
        durationMs: dispatchSegments.reduce(
          (sum, segment) => sum + segment.timing.totalMs,
          0,
        ),
        reviewRounds: new Set(
          segments
            .filter((segment) => segment.stage === 'code-review')
            .map((segment) => segment.round),
        ).size,
        findings,
        rebuts,
      },
      outcomes: {
        terminal: structuredClone(finish.payload.terminal),
        gate: structuredClone(finish.payload.gate),
        recovery: {
          ...structuredClone(finish.payload.recovery),
          contextParks: lifecycle.get('context-park').size,
        },
        overlap: {
          stagedAheadUnits: stagedAhead.size,
          utilizedUnits: utilized.size,
          avoidedIdleWait: derivedUnavailable(
            'authenticated raw events contain no independently attested counterfactual',
          ),
        },
        laneEffectiveness: {
          falseClassifications: lifecycle.get('false-lane-classification').size,
          scopeDriftFallbacks: lifecycle.get('scope-drift-fallback').size,
          avoidedEngineTime: derivedUnavailable(
            'authenticated raw events contain no independently attested counterfactual',
          ),
        },
        avoidedRework: {
          partialClaimsResumed: lifecycle.get('partial-claim-resumed').size,
          auditRecordsBackfilled: lifecycle.get('audit-record-backfilled').size,
          duplicateScansAvoided: lifecycle.get('duplicate-scan-avoided').size,
          falseDoctorFailuresPrevented:
            lifecycle.get('false-doctor-failure-prevented').size,
          avoidedTime: derivedUnavailable(
            'authenticated raw events contain no independently attested counterfactual',
          ),
        },
      },
    },
    observation: {
      runId,
      unitId: unitContext.unitId,
      runtimeRunFingerprint,
      terminalEvidenceFingerprint: finish.payload.terminalEvidence.fingerprint,
    },
  };
  const validation = validateMeasurement(recordValue);
  if (!validation.ok) {
    return {
      ok: false,
      errors: validation.errors.map((error) => `derived record: ${error}`),
    };
  }
  const derivation = eventSetDerivation(events);
  markDerivedRecord(recordValue, derivation);
  return { ok: true, record: recordValue, derivation };
}

const AVOIDED_EVIDENCE_PATHS = Object.freeze([
  {
    claim: 'unit.outcomes.overlap.avoidedIdleWait',
    observed: 'unit.timing.totalMs',
  },
  {
    claim: 'unit.outcomes.laneEffectiveness.avoidedEngineTime',
    observed: 'unit.timing.engineWaitMs',
  },
  {
    claim: 'unit.outcomes.avoidedRework.avoidedTime',
    observed: 'unit.timing.totalMs',
  },
]);

function validateRecordSet(records) {
  const errors = [];
  const invalidIndexes = new Set();
  if (!denseArray(errors, 'records', records, 0, MAX_STORE_RECORDS)) {
    return { ok: false, errors, invalidIndexes };
  }
  const byId = new Map();
  const byObservation = new Map();
  const byTerminalEvidence = new Map();
  const bySemanticObservation = new Map();
  for (const [index, recordValue] of records.entries()) {
    const existing = byId.get(recordValue?.recordId);
    if (existing !== undefined) {
      errors.push(
        `records[${index}].recordId: duplicate of records[${existing}] even if content differs`,
      );
      invalidIndexes.add(index);
      invalidIndexes.add(existing);
    } else {
      byId.set(recordValue?.recordId, index);
    }
    const observationKey = `${recordValue?.observation?.runId}:${recordValue?.observation?.unitId}`;
    const observationExisting = byObservation.get(observationKey);
    if (observationExisting !== undefined) {
      errors.push(
        `records[${index}].observation: duplicate run/unit identity from records[${observationExisting}]`,
      );
      invalidIndexes.add(index);
      invalidIndexes.add(observationExisting);
    } else {
      byObservation.set(observationKey, index);
    }
    const terminalEvidence = recordValue?.observation?.terminalEvidenceFingerprint;
    const terminalExisting = byTerminalEvidence.get(terminalEvidence);
    if (terminalExisting !== undefined) {
      errors.push(
        `records[${index}].observation.terminalEvidenceFingerprint: duplicate of records[${terminalExisting}]`,
      );
      invalidIndexes.add(index);
      invalidIndexes.add(terminalExisting);
    } else {
      byTerminalEvidence.set(terminalEvidence, index);
    }
    if (validateMeasurement(recordValue).ok) {
      const semantic = observationFingerprint(recordValue);
      const semanticExisting = bySemanticObservation.get(semantic);
      if (semanticExisting !== undefined) {
        errors.push(
          `records[${index}]: semantic observation clone of records[${semanticExisting}]`,
        );
        invalidIndexes.add(index);
        invalidIndexes.add(semanticExisting);
      } else {
        bySemanticObservation.set(semantic, index);
      }
    }
  }
  for (const [index, recordValue] of records.entries()) {
    for (const definition of AVOIDED_EVIDENCE_PATHS) {
      const claim = valueAt(recordValue, definition.claim);
      if (claim?.status !== 'verified') continue;
      if (!isTrustedRecord(recordValue)) {
        errors.push(`records[${index}].${definition.claim}: verified evidence is not authenticated`);
        invalidIndexes.add(index);
      }
      const observedValue = valueAt(recordValue, definition.observed);
      if (claim.evidence?.observedValue !== observedValue) {
        errors.push(`records[${index}].${definition.claim}: observed value does not match record`);
        invalidIndexes.add(index);
      }
      if (claim.method !== 'matched-control') continue;
      const controls = [];
      for (const controlRef of claim.evidence?.controlRecords ?? []) {
        const controlIndex = byId.get(controlRef.recordId);
        const control = controlIndex === undefined ? null : records[controlIndex];
        if (!control) {
          errors.push(
            `records[${index}].${definition.claim}: control ${controlRef.recordId} is absent`,
          );
          invalidIndexes.add(index);
          continue;
        }
        if (
          controlRef.contentFingerprint !== control.provenance?.contentFingerprint
          || !isTrustedRecord(control)
        ) {
          errors.push(
            `records[${index}].${definition.claim}: control ${controlRef.recordId} is not the authenticated content`,
          );
          invalidIndexes.add(index);
          continue;
        }
        if (
          !sameValue(
            strictCohortIdentity(recordValue, 'control'),
            strictCohortIdentity(control, 'control'),
          )
        ) {
          errors.push(
            `records[${index}].${definition.claim}: control ${controlRef.recordId} is from another cohort`,
          );
          invalidIndexes.add(index);
          continue;
        }
        controls.push(control);
      }
      if (controls.length === claim.evidence?.controlRecords?.length && controls.length > 0) {
        const expectedCounterfactual = median(
          controls.map((control) => valueAt(control, definition.observed)),
        );
        if (claim.evidence.counterfactualValue !== expectedCounterfactual) {
          errors.push(
            `records[${index}].${definition.claim}: counterfactual does not replay controls`,
          );
          invalidIndexes.add(index);
        }
      }
    }
  }
  return { ok: errors.length === 0, errors, invalidIndexes };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? sorted[middle - 1] / 2 + sorted[middle] / 2
    : sorted[middle];
}

function nearestRank(values, percentile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(percentile * sorted.length) - 1];
}

function valueAt(recordValue, path) {
  const value = path.split('.').reduce((current, key) => current?.[key], recordValue);
  return plainObject(value) && ['observed', 'unavailable'].includes(value.status)
    ? observationValue(value)
    : value;
}

function metricStatistics(samples, populationCount) {
  return {
    sampleCount: samples.length,
    unavailableCount: populationCount - samples.length,
    median: samples.length > 0 ? median(samples) : null,
    p95: samples.length >= 20 ? nearestRank(samples, 0.95) : null,
    provisional: samples.length < 100,
  };
}

function rateStatistics(successes, observations) {
  return {
    sampleCount: observations,
    successCount: successes,
    rate: observations > 0 ? successes / observations : null,
    provisional: observations < 100,
  };
}

const UNIT_NUMERIC_METRICS = [
  'unit.timing.timeToFirstSelectionMs',
  'unit.timing.totalMs',
  'unit.timing.activeMs',
  'unit.timing.engineWaitMs',
  'unit.timing.ciWaitMs',
  'unit.timing.humanWaitMs',
  'instrumentationOverhead.durationMs',
  'instrumentationOverhead.githubApi',
  'instrumentationOverhead.subprocesses',
  'instrumentationOverhead.remoteMutations',
  ...UNIT_TELEMETRY_KEYS.map((key) => `unit.telemetry.${key}`),
  ...CALL_KEYS.map((key) => `unit.calls.${key}`),
  'unit.dispatch.count',
  'unit.dispatch.durationMs',
  'unit.dispatch.reviewRounds',
  ...FINDING_KEYS.map((key) => `unit.dispatch.findings.${key}`),
  ...REBUT_KEYS.map((key) => `unit.dispatch.rebuts.${key}`),
  'unit.outcomes.recovery.contextParks',
  'unit.outcomes.overlap.stagedAheadUnits',
  'unit.outcomes.overlap.utilizedUnits',
  'unit.outcomes.laneEffectiveness.falseClassifications',
  'unit.outcomes.laneEffectiveness.scopeDriftFallbacks',
  'unit.outcomes.overlap.avoidedIdleWait.value',
  'unit.outcomes.laneEffectiveness.avoidedEngineTime.value',
  'unit.outcomes.avoidedRework.avoidedTime.value',
  ...AVOIDED_REWORK_KEYS
    .filter((key) => key !== 'avoidedTime')
    .map((key) => `unit.outcomes.avoidedRework.${key}`),
];
const SEGMENT_NUMERIC_METRICS = [
  'timing.totalMs',
  'timing.activeMs',
  'timing.engineWaitMs',
  'timing.ciWaitMs',
  'timing.humanWaitMs',
  ...UNIT_TELEMETRY_KEYS.map((key) => `telemetry.${key}`),
];

function actualRoutes(recordValue) {
  return [...new Set(recordValue.segments.map((segment) => segment.actualRoute))].sort();
}

function degradationKey(value) {
  return value === null ? null : { code: value.code, reason: value.reason };
}

function identityKey(value) {
  return value.status === 'observed'
    ? `observed:${value.value}`
    : `unavailable:${value.reason}`;
}

function recordMode(recordValue) {
  return {
    activeHost: recordValue.activeHost,
    selector: recordValue.selector,
    requestedEngine: recordValue.requestedEngine,
    requestedRoute: recordValue.requestedRoute,
    intentProvenance: recordValue.intentProvenance,
    actualRoutes: actualRoutes(recordValue),
    lane: recordValue.lane,
    mergePolicy: recordValue.mergePolicy,
    baseFreshnessStrategy: recordValue.baseFreshnessStrategy,
  };
}

const DYNAMIC_INVOCATION_EVIDENCE_FIELDS = [
  'capabilityFingerprint',
  'outageFingerprint',
  'outageTransition',
];

const COHORT_ALLOWED_VARIATION = Object.freeze({
  summarize: [...DYNAMIC_INVOCATION_EVIDENCE_FIELDS],
  compare: [
    'revision',
    'checkpoint',
    'recordId',
    'capturedAt',
    'checkpointEndpointFingerprint',
    'configFingerprint',
    ...DYNAMIC_INVOCATION_EVIDENCE_FIELDS,
    'routeRuntime',
    'terminalOutcome',
  ],
  budgetSource: [
    'recordId',
    'capturedAt',
    ...DYNAMIC_INVOCATION_EVIDENCE_FIELDS,
    'terminalOutcome',
  ],
  budgetCurrent: [
    'revision',
    'checkpoint',
    'recordId',
    'capturedAt',
    'checkpointEndpointFingerprint',
    ...DYNAMIC_INVOCATION_EVIDENCE_FIELDS,
    'terminalOutcome',
  ],
  control: [
    'revision',
    'checkpoint',
    'recordId',
    'capturedAt',
    ...DYNAMIC_INVOCATION_EVIDENCE_FIELDS,
    'terminalOutcome',
    'avoidedCostMethods',
  ],
});

function routeRuntimeIdentity(recordValue) {
  return recordValue.segments.map((segment) => ({
    stage: segment.stage,
    round: segment.round,
    role: segment.role,
    requestedRoute: segment.requestedRoute,
    actualRoute: segment.actualRoute,
    adapter: segment.adapter,
    degradation: degradationKey(segment.degradation),
    provider: identityKey(segment.telemetry.provider),
    model: identityKey(segment.telemetry.model),
    engine: identityKey(segment.telemetry.engine),
  }));
}

function stageIndependentRuntimeIdentity(recordValue) {
  const identities = recordValue.segments.map((segment) => ({
    role: segment.role,
    requestedRoute: segment.requestedRoute,
    actualRoute: segment.actualRoute,
    adapter: segment.adapter,
    degradation: degradationKey(segment.degradation),
    provider: identityKey(segment.telemetry.provider),
    model: identityKey(segment.telemetry.model),
    engine: identityKey(segment.telemetry.engine),
  }));
  return [...new Map(identities.map((identity) => [
    JSON.stringify(canonical(identity)),
    identity,
  ])).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, identity]) => identity);
}

function strictCohortIdentity(recordValue, operation = 'summarize') {
  const full = {
    revision: recordValue.revision,
    workload: recordValue.workload,
    checkpoint: recordValue.checkpoint,
    comparisonContextFingerprint: recordValue.comparisonContextFingerprint,
    checkpointEndpointFingerprint: recordValue.checkpointEndpointFingerprint,
    ...recordMode(recordValue),
    intent: recordValue.intent,
    configFingerprint: recordValue.configFingerprint,
    capabilityFingerprint: recordValue.capabilityFingerprint,
    outageFingerprint: recordValue.outageFingerprint,
    outageTransition: recordValue.outageTransition ?? 'none',
    stageIndependentRuntime: stageIndependentRuntimeIdentity(recordValue),
    routeRuntime: routeRuntimeIdentity(recordValue),
    terminalOutcome: recordValue.unit.outcomes.terminal,
    avoidedCostMethods: {
      idleWait: recordValue.unit.outcomes.overlap.avoidedIdleWait?.method ?? 'unavailable',
      engineTime:
        recordValue.unit.outcomes.laneEffectiveness.avoidedEngineTime?.method ?? 'unavailable',
      reworkTime:
        recordValue.unit.outcomes.avoidedRework.avoidedTime?.method ?? 'unavailable',
    },
  };
  const allowedToVary = COHORT_ALLOWED_VARIATION[operation] ?? [];
  return {
    identity: Object.fromEntries(
      Object.entries(full).filter(([key]) => !allowedToVary.includes(key)),
    ),
    allowedToVary,
  };
}

function unitCohort(recordValue) {
  return strictCohortIdentity(recordValue, 'summarize');
}

function segmentCohort(recordValue, segment) {
  return {
    ...strictCohortIdentity(recordValue, 'summarize'),
    stage: segment.stage,
    round: segment.round,
    role: segment.role,
    requestedSegmentRoute: segment.requestedRoute,
    actualSegmentRoute: segment.actualRoute,
    adapter: segment.adapter,
    degradation: degradationKey(segment.degradation),
    provider: identityKey(segment.telemetry.provider),
    model: identityKey(segment.telemetry.model),
    engine: identityKey(segment.telemetry.engine),
  };
}

function collectMetrics(values, paths, stepPrefix) {
  const dynamicSteps = new Set();
  for (const value of values) {
    for (const step of Object.keys(valueAt(value, `${stepPrefix}.steps`))) dynamicSteps.add(step);
  }
  const allPaths = [
    ...paths,
    ...[...dynamicSteps].sort().map((step) => `${stepPrefix}.steps.${step}`),
  ];
  return Object.fromEntries(allPaths.map((path) => {
    const samples = values.map((value) => valueAt(value, path)).filter(finiteNumber);
    return [path, metricStatistics(samples, values.length)];
  }));
}

function collectRates(records) {
  const attemptedGates = records.filter(
    (recordValue) => recordValue.unit.outcomes.gate.result !== 'not-run',
  );
  const interrupted = records.filter(
    (recordValue) => recordValue.unit.outcomes.recovery.resumeKind !== 'fresh',
  );
  const staged = records.reduce(
    (sum, recordValue) => sum + recordValue.unit.outcomes.overlap.stagedAheadUnits,
    0,
  );
  const utilized = records.reduce(
    (sum, recordValue) => sum + recordValue.unit.outcomes.overlap.utilizedUnits,
    0,
  );
  const accepted = records.reduce(
    (sum, recordValue) => sum + recordValue.unit.dispatch.rebuts.accepted,
    0,
  );
  const rejected = records.reduce(
    (sum, recordValue) => sum + recordValue.unit.dispatch.rebuts.rejected,
    0,
  );
  return {
    'gate.firstPass': rateStatistics(
      attemptedGates.filter(
        (recordValue) => recordValue.unit.outcomes.gate.result === 'first-pass',
      ).length,
      attemptedGates.length,
    ),
    'gate.localGreenCiRed': rateStatistics(
      records.filter(
        (recordValue) => recordValue.unit.outcomes.gate.localGreenCiRed,
      ).length,
      records.length,
    ),
    'recovery.resumed': rateStatistics(
      interrupted.filter(
        (recordValue) => recordValue.unit.outcomes.recovery.resumeKind === 'resumed',
      ).length,
      interrupted.length,
    ),
    'recovery.restarted': rateStatistics(
      interrupted.filter(
        (recordValue) => recordValue.unit.outcomes.recovery.resumeKind === 'restarted',
      ).length,
      interrupted.length,
    ),
    'overlap.utilized': rateStatistics(utilized, staged),
    'lane.falseClassification': rateStatistics(
      records.filter(
        (recordValue) =>
          recordValue.unit.outcomes.laneEffectiveness.falseClassifications > 0,
      ).length,
      records.length,
    ),
    'lane.scopeDriftFallback': rateStatistics(
      records.filter(
        (recordValue) =>
          recordValue.unit.outcomes.laneEffectiveness.scopeDriftFallbacks > 0,
      ).length,
      records.length,
    ),
    'review.acceptedRebut': rateStatistics(accepted, accepted + rejected),
  };
}

function grouped(values, cohortFor) {
  const groups = new Map();
  for (const value of values) {
    const cohort = cohortFor(value);
    const key = JSON.stringify(canonical(cohort));
    if (!groups.has(key)) groups.set(key, { cohort, values: [] });
    groups.get(key).values.push(value);
  }
  return [...groups.values()];
}

function countedValues(values) {
  const counts = new Map();
  for (const value of values) {
    const key = JSON.stringify(canonical(value));
    const current = counts.get(key);
    counts.set(key, {
      value,
      count: (current?.count ?? 0) + 1,
    });
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, counted]) => counted);
}

function invocationEvidence(records) {
  return {
    configFingerprints: countedValues(
      records.map((recordValue) => recordValue.configFingerprint),
    ),
    capabilityFingerprints: countedValues(
      records.map((recordValue) => recordValue.capabilityFingerprint),
    ),
    outageFingerprints: countedValues(
      records.map((recordValue) => recordValue.outageFingerprint),
    ),
    outageTransitions: countedValues(
      records.map((recordValue) => recordValue.outageTransition),
    ),
  };
}

export function summarizeMeasurements(records) {
  const uniqueness = validateRecordSet(records);
  const invalid = [];
  const valid = [];
  records.forEach((recordValue, index) => {
    const result = validateMeasurement(recordValue);
    if (result.ok && !uniqueness.invalidIndexes.has(index)) valid.push(recordValue);
    else invalid.push({ index, errors: result.errors });
  });
  const unitCohorts = grouped(valid, unitCohort).map(({ cohort, values }) => ({
    cohort,
    sampleCount: values.length,
    metrics: collectMetrics(values, UNIT_NUMERIC_METRICS, 'unit.timing'),
    rates: collectRates(values),
    invocationEvidence: invocationEvidence(values),
  }));
  const flattened = valid.flatMap((recordValue) =>
    recordValue.segments.map((segment) => ({ recordValue, segment })));
  const segmentCohorts = grouped(
    flattened,
    ({ recordValue, segment }) => segmentCohort(recordValue, segment),
  ).map(({ cohort, values }) => ({
    cohort,
    sampleCount: values.length,
    metrics: collectMetrics(
      values.map(({ segment }) => segment),
      SEGMENT_NUMERIC_METRICS,
      'timing',
    ),
    invocationEvidence: invocationEvidence(
      values.map(({ recordValue }) => recordValue),
    ),
  }));
  invalid.push(...uniqueness.errors.map((error) => ({ index: null, errors: [error] })));
  return { invalid, unitCohorts, segmentCohorts };
}

function comparisonKey(recordValue) {
  return strictCohortIdentity(recordValue, 'compare');
}

function comparisonEndpointIdentity(recordValue) {
  return { checkpointEndpointFingerprint: recordValue.checkpointEndpointFingerprint };
}

function comparisonCheckpointIdentityErrors(name, records) {
  if (records.length === 0) return [];
  const endpointCount = grouped(records, comparisonEndpointIdentity).length;
  const revisionCount = new Set(
    records.map((recordValue) => recordValue.revision),
  ).size;
  const configCount = new Set(
    records.map((recordValue) => recordValue.configFingerprint),
  ).size;
  return endpointCount === 1 && revisionCount === 1 && configCount === 1
    ? []
    : [`${name}: comparison requires one endpoint, revision, and configuration`];
}

function runtimeIdentityAvailabilityErrors(records, context) {
  return records.flatMap((recordValue) =>
    recordValue.segments.flatMap((segment) =>
      ['provider', 'model', 'engine']
        .filter((identity) => segment.telemetry[identity].status !== 'observed')
        .map(
          (identity) =>
            `${recordValue.recordId}:${segment.id}:${identity} must be observed for ${context}`,
        )));
}

function aggregateUnitRecords(records) {
  return {
    sampleCount: records.length,
    metrics: collectMetrics(records, UNIT_NUMERIC_METRICS, 'unit.timing'),
    rates: collectRates(records),
    terminalOutcomes: countedValues(
      records.map((recordValue) => recordValue.unit.outcomes.terminal),
    ),
    invocationEvidence: invocationEvidence(records),
  };
}

export function compareCheckpoints(records, afterCheckpoint = 'safe-system') {
  if (!['safe-system', 'post-optimization'].includes(afterCheckpoint)) {
    return { ok: false, errors: ['afterCheckpoint: expected safe-system or post-optimization'] };
  }
  const uniqueness = validateRecordSet(records);
  const invalid = records
    .map((recordValue, index) => ({ index, result: validateMeasurement(recordValue) }))
    .filter(({ result }) => !result.ok);
  if (invalid.length > 0 || !uniqueness.ok) {
    return {
      ok: false,
      errors: [
        ...invalid.map(({ index, result }) => `${index}: ${result.errors.join('; ')}`),
        ...uniqueness.errors,
      ],
    };
  }
  const eligible = records.filter(
    (recordValue) =>
      recordValue.mergePolicy === 'manual'
      && ['legacy-workflow', afterCheckpoint].includes(recordValue.checkpoint),
  );
  const unavailableIdentities = runtimeIdentityAvailabilityErrors(
    eligible,
    'comparison',
  );
  if (unavailableIdentities.length > 0) {
    return {
      ok: false,
      errors: unavailableIdentities,
    };
  }
  const nonCompleted = eligible.filter(
    (recordValue) => recordValue.unit.outcomes.terminal.status !== 'completed',
  );
  if (nonCompleted.length > 0) {
    return {
      ok: false,
      errors: nonCompleted.map(
        (recordValue) =>
          `${recordValue.recordId}: checkpoint comparison requires a completed unit`,
      ),
    };
  }
  const groups = grouped(eligible, comparisonKey);
  const matches = [];
  const unmatched = [];
  for (const { cohort, values } of groups) {
    const before = values.filter(
      (recordValue) => recordValue.checkpoint === 'legacy-workflow',
    );
    const after = values.filter(
      (recordValue) => recordValue.checkpoint === afterCheckpoint,
    );
    const identityErrors = [
      ...comparisonCheckpointIdentityErrors('legacy-workflow', before),
      ...comparisonCheckpointIdentityErrors(afterCheckpoint, after),
    ];
    if (identityErrors.length > 0) {
      return {
        ok: false,
        errors: identityErrors,
      };
    }
    const beforeSummary = before.length > 0 ? aggregateUnitRecords(before) : null;
    const afterSummary = after.length > 0 ? aggregateUnitRecords(after) : null;
    if (before.length === 0 || after.length === 0) {
      unmatched.push({
        cohort,
        legacyCount: before.length,
        afterCount: after.length,
        legacy: beforeSummary,
        after: afterSummary,
      });
      continue;
    }
    const deltas = {};
    for (const path of new Set([
      ...Object.keys(beforeSummary.metrics),
      ...Object.keys(afterSummary.metrics),
    ])) {
      const beforeMetric = beforeSummary.metrics[path];
      const afterMetric = afterSummary.metrics[path];
      deltas[path] = {
        median:
          beforeMetric?.median !== null && afterMetric?.median !== null
            ? afterMetric.median - beforeMetric.median
            : null,
        p95:
          beforeMetric?.p95 !== null && afterMetric?.p95 !== null
            ? afterMetric.p95 - beforeMetric.p95
            : null,
      };
    }
    matches.push({
      cohort,
      before: beforeSummary,
      after: afterSummary,
      deltas,
    });
  }
  return {
    ok: true,
    beforeCheckpoint: 'legacy-workflow',
    afterCheckpoint,
    matches,
    unmatched,
  };
}

function sameValue(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function budgetMetricEvidence(records, definition) {
  const samples = records
    .map((recordValue) => valueAt(recordValue, definition.path))
    .filter(finiteNumber);
  const value =
    definition.statistic === 'p95'
      ? (samples.length >= 20 ? nearestRank(samples, 0.95) : null)
      : (samples.length > 0 ? median(samples) : null);
  return {
    statistic: definition.statistic,
    value,
    sampleCount: samples.length,
  };
}

function sourceFingerprint(source, workload, mode) {
  return fingerprint({
    checkpoint: source.checkpoint,
    revision: source.revision,
    workload,
    mode,
    records: source.records,
    evidence: source.evidence,
  });
}

export function buildBudgetSource(records) {
  const validations = records.map(validateMeasurement);
  const recordSet = validateRecordSet(records);
  if (
    records.length === 0
    || validations.some((result) => !result.ok)
    || !recordSet.ok
    || records.some((recordValue) => recordValue.checkpoint !== 'safe-system')
  ) {
    return {
      ok: false,
      errors: [
        'source requires unique authenticated valid safe-system records',
        ...validations.flatMap((result, index) =>
          result.ok ? [] : result.errors.map((error) => `records[${index}]: ${error}`)),
        ...recordSet.errors,
      ],
    };
  }
  if (records.some((recordValue) => !isTrustedDerivedRecord(recordValue))) {
    return {
      ok: false,
      errors: [
        'source records must be replay-verified aggregates derived from authenticated raw events',
      ],
    };
  }
  const unavailableIdentities = runtimeIdentityAvailabilityErrors(
    records,
    'budget source',
  );
  if (unavailableIdentities.length > 0) {
    return { ok: false, errors: unavailableIdentities };
  }
  if (
    records.some(
      (recordValue) => recordValue.unit.outcomes.terminal.status !== 'completed',
    )
  ) {
    return { ok: false, errors: ['budget source requires completed units'] };
  }
  const first = records[0];
  const mode = recordMode(first);
  const cohort = strictCohortIdentity(first, 'budgetSource');
  if (
    records.some(
      (recordValue) =>
        recordValue.workload !== first.workload
        || recordValue.revision !== first.revision
        || !sameValue(recordMode(recordValue), mode)
        || !sameValue(strictCohortIdentity(recordValue, 'budgetSource'), cohort),
    )
  ) {
    return {
      ok: false,
      errors: ['source records must share the complete budget-source cohort identity'],
    };
  }
  const sourceRecords = records.map((recordValue) => ({
    recordId: recordValue.recordId,
    contentFingerprint: recordValue.provenance.contentFingerprint,
    provenanceMac: recordValue.provenance.mac,
  })).sort((left, right) => left.recordId.localeCompare(right.recordId));
  const evidence = Object.fromEntries(
    Object.entries(BUDGET_METRICS).map(([name, definition]) => [
      name,
      budgetMetricEvidence(records, definition),
    ]),
  );
  const source = {
    checkpoint: 'safe-system',
    revision: first.revision,
    cohortFingerprint: '',
    records: sourceRecords,
    evidence,
  };
  source.cohortFingerprint = sourceFingerprint(source, first.workload, mode);
  return {
    ok: true,
    workload: first.workload,
    mode,
    source,
    invocationEvidence: invocationEvidence(records),
  };
}

function validateMode(errors, value) {
  if (!exactObject(errors, 'mode', value, MODE_KEYS)) return;
  requireEnum(errors, 'mode.activeHost', value.activeHost, HOSTS);
  requireEnum(errors, 'mode.selector', value.selector, SELECTORS);
  requireEnum(errors, 'mode.requestedEngine', value.requestedEngine, HOSTS);
  requireEnum(errors, 'mode.requestedRoute', value.requestedRoute, ROUTES);
  if (value.intentProvenance !== INTENT_PROVENANCE) {
    errors.push(`mode.intentProvenance: expected ${INTENT_PROVENANCE}`);
  }
  requireEnum(errors, 'mode.lane', value.lane, LANES);
  requireEnum(errors, 'mode.mergePolicy', value.mergePolicy, MERGE_POLICIES);
  requireEnum(
    errors,
    'mode.baseFreshnessStrategy',
    value.baseFreshnessStrategy,
    BASE_STRATEGIES,
  );
  if (denseArray(errors, 'mode.actualRoutes', value.actualRoutes, 1, 5)) {
    const sorted = [...value.actualRoutes].sort();
    if (new Set(value.actualRoutes).size !== value.actualRoutes.length) {
      errors.push('mode.actualRoutes: routes must be unique');
    }
    if (!sameValue(sorted, value.actualRoutes)) {
      errors.push('mode.actualRoutes: routes must be sorted');
    }
    value.actualRoutes.forEach((route, index) => {
      requireEnum(errors, `mode.actualRoutes[${index}]`, route, ROUTES);
      if (ROUTES.has(route) && ROUTE_CATALOG[route].activeHost !== value.activeHost) {
        errors.push(`mode.actualRoutes[${index}]: route belongs to a different host`);
      }
    });
  }
  const engine = value.selector === 'native' ? value.activeHost : value.selector;
  const route = expectedRequestedRoute(value.activeHost, engine);
  if (value.requestedEngine !== engine || value.requestedRoute !== route) {
    errors.push('mode: selector, requested engine, and route are inconsistent');
  }
}

export function validateBudgetSpec(value) {
  const graph = validateDataGraph(value);
  if (!graph.ok) return graph;
  const errors = [];
  if (!exactObject(errors, 'budget', value, BUDGET_KEYS)) return { ok: false, errors };
  if (value.version !== BUDGET_VERSION) errors.push(`budget.version: expected ${BUDGET_VERSION}`);
  if (!UUID_RE.test(value.budgetId ?? '')) errors.push('budget.budgetId: expected UUID v4');
  if (!canonicalTimestamp(value.createdAt)) {
    errors.push('budget.createdAt: expected a canonical UTC timestamp');
  }
  if (!NAME_RE.test(value.workload ?? '')) errors.push('budget.workload: invalid identifier');
  validateMode(errors, value.mode);
  if (exactObject(errors, 'budget.source', value.source, BUDGET_SOURCE_KEYS)) {
    if (value.source.checkpoint !== 'safe-system') {
      errors.push('budget.source.checkpoint: expected safe-system');
    }
    if (!SHA_RE.test(value.source.revision ?? '')) {
      errors.push('budget.source.revision: expected commit OID');
    }
    if (!HASH_RE.test(value.source.cohortFingerprint ?? '')) {
      errors.push('budget.source.cohortFingerprint: expected sha256');
    }
    if (denseArray(errors, 'budget.source.records', value.source.records, 1, MAX_STORE_RECORDS)) {
      const ids = value.source.records.map((record) => record?.recordId);
      const sorted = [...ids].sort();
      if (new Set(ids).size !== ids.length) errors.push('budget.source.records: IDs must be unique');
      if (!sameValue(sorted, ids)) errors.push('budget.source.records: records must be ID-sorted');
      value.source.records.forEach((record, index) => {
        const path = `budget.source.records[${index}]`;
        if (!exactObject(errors, path, record, SOURCE_RECORD_KEYS)) return;
        if (!UUID_RE.test(record.recordId ?? '')) errors.push(`${path}.recordId: expected UUID v4`);
        if (!HASH_RE.test(record.contentFingerprint ?? '')) {
          errors.push(`${path}.contentFingerprint: expected sha256`);
        }
        if (!HASH_RE.test(record.provenanceMac ?? '')) {
          errors.push(`${path}.provenanceMac: expected sha256 HMAC`);
        }
      });
    }
    if (
      exactObject(
        errors,
        'budget.source.evidence',
        value.source.evidence,
        BUDGET_METRIC_KEYS,
      )
    ) {
      for (const [name, definition] of Object.entries(BUDGET_METRICS)) {
        const evidence = value.source.evidence[name];
        if (!exactObject(errors, `budget.source.evidence.${name}`, evidence, EVIDENCE_KEYS)) {
          continue;
        }
        if (evidence.statistic !== definition.statistic) {
          errors.push(
            `budget.source.evidence.${name}.statistic: expected ${definition.statistic}`,
          );
        }
        if (evidence.value !== null) {
          requireNumber(errors, `budget.source.evidence.${name}.value`, evidence.value);
        }
        requireNumber(
          errors,
          `budget.source.evidence.${name}.sampleCount`,
          evidence.sampleCount,
          true,
        );
        if (
          integer(evidence.sampleCount)
          && Array.isArray(value.source.records)
          && evidence.sampleCount > value.source.records.length
        ) {
          errors.push(`budget.source.evidence.${name}.sampleCount: exceeds source records`);
        }
      }
    }
    if (
      errors.length === 0
      && HASH_RE.test(value.source.cohortFingerprint ?? '')
      && value.source.cohortFingerprint
        !== sourceFingerprint(value.source, value.workload, value.mode)
    ) {
      errors.push('budget.source.cohortFingerprint: does not match source evidence');
    }
  }
  if (exactObject(errors, 'budget.floors', value.floors, BUDGET_FLOOR_KEYS)) {
    for (const key of BUDGET_FLOOR_KEYS) {
      requireNumber(errors, `budget.floors.${key}`, value.floors[key], true);
    }
    if (integer(value.floors.median) && value.floors.median < 1) {
      errors.push('budget.floors.median: must be at least 1');
    }
    if (integer(value.floors.p95) && value.floors.p95 < 20) {
      errors.push('budget.floors.p95: must be at least 20');
    }
    if (integer(value.floors.stable) && value.floors.stable < 100) {
      errors.push('budget.floors.stable: must be at least 100');
    }
    if (
      integer(value.floors.median)
      && integer(value.floors.p95)
      && integer(value.floors.stable)
      && Math.max(value.floors.median, value.floors.p95) > value.floors.stable
    ) {
      errors.push('budget.floors: stable must cover median and p95 floors');
    }
  }
  if (exactObject(errors, 'budget.limits', value.limits, BUDGET_METRIC_KEYS)) {
    for (const key of BUDGET_METRIC_KEYS) {
      requireNumber(errors, `budget.limits.${key}`, value.limits[key]);
    }
  }
  return { ok: errors.length === 0, errors };
}

function budgetEvidenceMatches(source, records, workload, mode) {
  const selected = records.filter((recordValue) =>
    source.records.some((sourceRecord) => sourceRecord.recordId === recordValue.recordId));
  if (selected.length !== source.records.length) return false;
  const built = buildBudgetSource(selected);
  return built.ok
    && built.workload === workload
    && sameValue(built.mode, mode)
    && sameValue(built.source, source);
}

function recordsForBudget(records, workload, mode) {
  return records.filter(
    (recordValue) =>
      validateMeasurement(recordValue).ok
      && recordValue.workload === workload
      && sameValue(recordMode(recordValue), mode),
  );
}

function readiness(evidence, floors) {
  const reportingFloor = evidence.statistic === 'p95' ? floors.p95 : floors.median;
  if (evidence.sampleCount < reportingFloor || evidence.value === null) return 'refused';
  if (evidence.sampleCount < floors.stable) return 'provisional';
  return 'stable';
}

export function evaluateBudget(spec, baselineRecords, currentRecords) {
  const validation = validateBudgetSpec(spec);
  if (!validation.ok) return { ok: false, status: 'refused', errors: validation.errors };
  if (!Array.isArray(baselineRecords) || !Array.isArray(currentRecords)) {
    return {
      ok: false,
      status: 'refused',
      errors: ['budget evaluation requires record arrays'],
    };
  }
  const baselineSet = validateRecordSet(baselineRecords);
  const currentSet = validateRecordSet(currentRecords);
  if (
    baselineRecords.some((recordValue) => !validateMeasurement(recordValue).ok)
    || currentRecords.some((recordValue) => !validateMeasurement(recordValue).ok)
    || !baselineSet.ok
    || !currentSet.ok
    || [...baselineRecords, ...currentRecords].some(
      (recordValue) => !isTrustedDerivedRecord(recordValue),
    )
  ) {
    return {
      ok: false,
      status: 'refused',
      errors: [
        'budget evaluation requires unique replay-verified records derived from authenticated raw events',
        ...baselineSet.errors,
        ...currentSet.errors,
      ],
    };
  }
  const unavailableIdentities = runtimeIdentityAvailabilityErrors(
    [...baselineRecords, ...currentRecords],
    'budget evaluation',
  );
  if (unavailableIdentities.length > 0) {
    return {
      ok: false,
      status: 'refused',
      errors: unavailableIdentities,
    };
  }
  if (
    [...baselineRecords, ...currentRecords].some(
      (recordValue) => recordValue.unit.outcomes.terminal.status !== 'completed',
    )
  ) {
    return {
      ok: false,
      status: 'refused',
      errors: ['budget evaluation requires completed units'],
    };
  }
  const sourceIds = new Set(spec.source.records.map((recordValue) => recordValue.recordId));
  if (
    baselineRecords.length !== sourceIds.size
    || baselineRecords.some((recordValue) => !sourceIds.has(recordValue.recordId))
  ) {
    return {
      ok: false,
      status: 'refused',
      errors: ['baseline records must be exactly the named authenticated source set'],
    };
  }
  const baselineObservations = new Set(
    baselineRecords.map(
      (recordValue) => `${recordValue.observation.runId}:${recordValue.observation.unitId}`,
    ),
  );
  if (
    currentRecords.some((recordValue) =>
      baselineObservations.has(
        `${recordValue.observation.runId}:${recordValue.observation.unitId}`,
      ))
  ) {
    return {
      ok: false,
      status: 'refused',
      errors: ['current observations must be independent from source observations'],
    };
  }
  const baselineTerminalEvidence = new Set(
    baselineRecords.map(
      (recordValue) => recordValue.observation.terminalEvidenceFingerprint,
    ),
  );
  if (
    currentRecords.some((recordValue) =>
      baselineTerminalEvidence.has(recordValue.observation.terminalEvidenceFingerprint))
  ) {
    return {
      ok: false,
      status: 'refused',
      errors: ['current terminal evidence must be independent from source evidence'],
    };
  }
  if (!budgetEvidenceMatches(spec.source, baselineRecords, spec.workload, spec.mode)) {
    return {
      ok: false,
      status: 'refused',
      errors: ['safe-system source records do not match the budget evidence'],
    };
  }
  if (
    currentRecords.some(
      (recordValue) =>
        recordValue.checkpoint !== 'post-optimization'
        || recordValue.workload !== spec.workload
        || !sameValue(recordMode(recordValue), spec.mode),
    )
    || currentRecords.some((recordValue) =>
      spec.source.records.some((sourceRecord) => sourceRecord.recordId === recordValue.recordId))
  ) {
    return {
      ok: false,
      status: 'refused',
      errors: ['current records must be a disjoint matching post-optimization cohort'],
    };
  }
  const namedBaseline = spec.source.records
    .map((sourceRecord) =>
      baselineRecords.find((recordValue) => recordValue.recordId === sourceRecord.recordId));
  if (
    new Set(
      currentRecords.map((recordValue) => recordValue.checkpointEndpointFingerprint),
    ).size !== 1
    || new Set(
      currentRecords.map((recordValue) => recordValue.revision),
    ).size !== 1
  ) {
    return {
      ok: false,
      status: 'refused',
      errors: ['current records must share one checkpoint endpoint and revision'],
    };
  }
  const baselineIdentity = strictCohortIdentity(namedBaseline[0], 'budgetCurrent');
  if (
    namedBaseline.some(
      (recordValue) =>
        !sameValue(strictCohortIdentity(recordValue, 'budgetCurrent'), baselineIdentity),
    )
  ) {
    return {
      ok: false,
      status: 'refused',
      errors: ['named source records do not share the complete cohort identity'],
    };
  }
  if (
    currentRecords.some(
      (recordValue) =>
        !sameValue(strictCohortIdentity(recordValue, 'budgetCurrent'), baselineIdentity),
    )
  ) {
    return {
      ok: false,
      status: 'refused',
      errors: ['current records do not share the complete source cohort identity'],
    };
  }
  const current = recordsForBudget(currentRecords, spec.workload, spec.mode);
  if (current.length === 0) {
    return { ok: false, status: 'refused', errors: ['no current records match budget mode'] };
  }
  const results = {};
  let provisional = false;
  let refused = false;
  let failed = false;
  for (const [name, definition] of Object.entries(BUDGET_METRICS)) {
    const baseline = spec.source.evidence[name];
    const observed = budgetMetricEvidence(current, definition);
    const baselineReadiness = readiness(baseline, spec.floors);
    const currentReadiness = readiness(observed, spec.floors);
    const status =
      baselineReadiness === 'refused' || currentReadiness === 'refused'
        ? 'refused'
        : baselineReadiness === 'provisional' || currentReadiness === 'provisional'
          ? 'provisional'
          : observed.value <= spec.limits[name]
            ? 'passed'
            : 'failed';
    refused ||= status === 'refused';
    provisional ||= status === 'provisional';
    failed ||= status === 'failed';
    results[name] = {
      limit: spec.limits[name],
      baseline,
      observed,
      withinLimit: observed.value === null ? null : observed.value <= spec.limits[name],
      status,
    };
  }
  const status = refused
    ? 'refused'
    : provisional
      ? 'provisional'
      : failed
        ? 'failed'
        : 'passed';
  return {
    ok: status === 'passed',
    status,
    metrics: results,
    baselineInvocationEvidence: invocationEvidence(baselineRecords),
    currentInvocationEvidence: invocationEvidence(currentRecords),
  };
}

function validatePolicyIds(errors, path, value, minimum) {
  if (!denseArray(errors, path, value, minimum, MAX_STORE_RECORDS)) return;
  if (value.some((recordId) => !UUID_RE.test(recordId ?? ''))) {
    errors.push(`${path}: expected lowercase UUID v4 values`);
  }
  if (new Set(value).size !== value.length) {
    errors.push(`${path}: IDs must be unique`);
  }
  if (!sameValue([...value].sort(), value)) {
    errors.push(`${path}: IDs must be sorted`);
  }
}

function budgetPolicyRouteKey(entry) {
  return `${entry.budget.workload}\u0000${JSON.stringify(canonical(entry.budget.mode))}`;
}

export function validateBudgetPolicy(value) {
  const graph = validateDataGraph(value);
  if (!graph.ok) return graph;
  const errors = [];
  if (!exactObject(errors, 'policy', value, BUDGET_POLICY_KEYS)) {
    return { ok: false, errors };
  }
  if (value.version !== BUDGET_POLICY_VERSION) {
    errors.push(`policy.version: expected ${BUDGET_POLICY_VERSION}`);
  }
  requireEnum(errors, 'policy.status', value.status, BUDGET_POLICY_STATUSES);
  if (value.status === 'pending-evidence') {
    requireString(errors, 'policy.reason', value.reason, 500);
    if (value.evidenceBundle !== null) {
      errors.push('policy.evidenceBundle: pending policy requires null');
    }
    if (!denseArray(errors, 'policy.budgets', value.budgets, 0, 0)) {
      return { ok: false, errors };
    }
    return { ok: errors.length === 0, errors };
  }
  if (value.status !== 'active') return { ok: false, errors };
  if (value.reason !== null) errors.push('policy.reason: active policy requires null');
  if (exactObject(
    errors,
    'policy.evidenceBundle',
    value.evidenceBundle,
    BUDGET_POLICY_EVIDENCE_KEYS,
  )) {
    if (value.evidenceBundle.path !== MEASUREMENT_EVIDENCE_BUNDLE_PATH) {
      errors.push(
        `policy.evidenceBundle.path: expected ${MEASUREMENT_EVIDENCE_BUNDLE_PATH}`,
      );
    }
    if (!HASH_RE.test(value.evidenceBundle.sha256 ?? '')) {
      errors.push('policy.evidenceBundle.sha256: expected sha256');
    }
  }
  if (!denseArray(errors, 'policy.budgets', value.budgets, 1, 100)) {
    return { ok: false, errors };
  }
  const routeKeys = [];
  const usedRecordIds = new Set();
  const usedBudgetIds = new Set();
  value.budgets.forEach((entry, index) => {
    const path = `policy.budgets[${index}]`;
    if (!exactObject(errors, path, entry, BUDGET_POLICY_ENTRY_KEYS)) return;
    const budgetValidation = validateBudgetSpec(entry.budget);
    errors.push(...budgetValidation.errors.map((error) => `${path}.${error}`));
    validatePolicyIds(errors, `${path}.baselineRecordIds`, entry.baselineRecordIds, 1);
    validatePolicyIds(errors, `${path}.currentRecordIds`, entry.currentRecordIds, 1);
    if (!budgetValidation.ok) return;
    if (usedBudgetIds.has(entry.budget.budgetId)) {
      errors.push(`${path}.budget.budgetId: duplicate policy budget`);
    }
    usedBudgetIds.add(entry.budget.budgetId);
    const sourceIds = entry.budget.source.records.map((record) => record.recordId);
    if (!sameValue(sourceIds, entry.baselineRecordIds)) {
      errors.push(`${path}.baselineRecordIds: must exactly equal budget source IDs`);
    }
    for (const recordId of [...entry.baselineRecordIds, ...entry.currentRecordIds]) {
      if (usedRecordIds.has(recordId)) {
        errors.push(`${path}: record ${recordId} is reused across policy cohorts`);
      }
      usedRecordIds.add(recordId);
    }
    const routeKey = budgetPolicyRouteKey(entry);
    if (routeKeys.includes(routeKey)) {
      errors.push(`${path}: duplicate workload and execution mode`);
    }
    routeKeys.push(routeKey);
  });
  if (!sameValue([...routeKeys].sort(), routeKeys)) {
    errors.push('policy.budgets: entries must be sorted by workload and execution mode');
  }
  return { ok: errors.length === 0, errors };
}

export function canonicalBudgetPolicy(value) {
  const validation = validateBudgetPolicy(value);
  if (!validation.ok) {
    throw new Error(`invalid budget policy: ${validation.errors.join('; ')}`);
  }
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

export function parseBudgetPolicy(source) {
  if (
    typeof source !== 'string'
    || Buffer.byteLength(source) === 0
    || Buffer.byteLength(source) > MAX_POLICY_BYTES
  ) {
    return {
      ok: false,
      errors: [`budget policy must be 1..${MAX_POLICY_BYTES} UTF-8 bytes`],
    };
  }
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    return { ok: false, errors: [`budget policy JSON is invalid: ${error.message}`] };
  }
  const validation = validateBudgetPolicy(value);
  if (!validation.ok) return { ...validation, policy: value };
  if (canonicalBudgetPolicy(value) !== source) {
    return {
      ok: false,
      errors: [
        'budget policy must use the canonical serialization; duplicate or reordered fields are refused',
      ],
      policy: value,
    };
  }
  return { ok: true, errors: [], policy: value };
}

export function evaluateBudgetPolicy(policy, records) {
  const validation = validateBudgetPolicy(policy);
  if (!validation.ok) {
    return {
      ok: false,
      status: 'invalid',
      passed: false,
      errors: validation.errors,
      evaluations: [],
    };
  }
  if (policy.status === 'pending-evidence') {
    return {
      ok: true,
      status: 'pending-evidence',
      passed: false,
      reason: policy.reason,
      evaluations: [],
    };
  }
  if (!Array.isArray(records)) {
    return {
      ok: false,
      status: 'refused',
      passed: false,
      errors: ['active policy requires an authenticated measurement record array'],
      evaluations: [],
    };
  }
  const recordSet = validateRecordSet(records);
  if (
    !recordSet.ok
    || records.some((recordValue) => !validateMeasurement(recordValue).ok)
    || records.some((recordValue) => !isTrustedDerivedRecord(recordValue))
  ) {
    return {
      ok: false,
      status: 'refused',
      passed: false,
      errors: [
        'active policy accepts only unique replay-verified aggregates derived from authenticated raw events',
        ...recordSet.errors,
      ],
      evaluations: [],
    };
  }
  const byId = new Map(records.map((recordValue) => [recordValue.recordId, recordValue]));
  const evaluations = policy.budgets.map((entry) => {
    const ids = [...entry.baselineRecordIds, ...entry.currentRecordIds];
    const missing = ids.filter((recordId) => !byId.has(recordId));
    if (missing.length > 0) {
      return {
        budgetId: entry.budget.budgetId,
        workload: entry.budget.workload,
        mode: entry.budget.mode,
        ok: false,
        status: 'refused',
        errors: [`missing authenticated records: ${missing.join(', ')}`],
      };
    }
    return {
      budgetId: entry.budget.budgetId,
      workload: entry.budget.workload,
      mode: entry.budget.mode,
      ...evaluateBudget(
        entry.budget,
        entry.baselineRecordIds.map((recordId) => byId.get(recordId)),
        entry.currentRecordIds.map((recordId) => byId.get(recordId)),
      ),
    };
  });
  const passed = evaluations.every((evaluation) =>
    evaluation.ok && evaluation.status === 'passed');
  const status = passed
    ? 'passed'
    : evaluations.some((evaluation) => evaluation.status === 'refused')
      ? 'refused'
      : evaluations.some((evaluation) => evaluation.status === 'provisional')
        ? 'provisional'
        : 'failed';
  return { ok: passed, status, passed, evaluations };
}

export function validateMeasurementEvidenceBundle(value) {
  const graph = validateDataGraph(value, {
    maximumNodes: MAX_BUNDLE_DATA_NODES,
    rootPath: 'bundle',
  });
  if (!graph.ok) return graph;
  const errors = [];
  if (!exactObject(errors, 'bundle', value, EVIDENCE_BUNDLE_KEYS)) {
    return { ok: false, errors };
  }
  if (value.version !== MEASUREMENT_EVIDENCE_BUNDLE_VERSION) {
    errors.push(
      `bundle.version: expected ${MEASUREMENT_EVIDENCE_BUNDLE_VERSION}`,
    );
  }
  if (value.kind !== 'autoloop-measurement-evidence') {
    errors.push('bundle.kind: expected autoloop-measurement-evidence');
  }
  if (!canonicalTimestamp(value.createdAt)) {
    errors.push('bundle.createdAt: expected canonical UTC timestamp');
  }
  if (!denseArray(errors, 'bundle.records', value.records, 1, MAX_STORE_RECORDS)) {
    return { ok: false, errors };
  }
  const recordIds = new Set();
  const runIds = new Set();
  for (const [index, entry] of value.records.entries()) {
    const path = `bundle.records[${index}]`;
    if (!exactObject(errors, path, entry, EVIDENCE_BUNDLE_RECORD_KEYS)) continue;
    const recordValidation = validateMeasurement(entry.record);
    errors.push(...recordValidation.errors.map((error) => `${path}.record.${error}`));
    if (
      entry.record?.provenance?.capture?.observationSource
        !== 'derived-authenticated-events'
      || entry.record?.provenance?.derivation === undefined
    ) {
      errors.push(`${path}.record: expected event-derived authenticated provenance`);
    }
    if (recordIds.has(entry.record?.recordId)) {
      errors.push(`${path}.record.recordId: duplicate bundle record`);
    }
    recordIds.add(entry.record?.recordId);
    const runId = entry.record?.observation?.runId;
    if (runIds.has(runId)) errors.push(`${path}.record.observation.runId: duplicate run`);
    runIds.add(runId);
    if (!denseArray(errors, `${path}.events`, entry.events, 2, MAX_RUN_EVENTS)) {
      continue;
    }
    for (const [eventIndex, eventValue] of entry.events.entries()) {
      const eventValidation = validateMeasurementEventRecord(eventValue);
      errors.push(...eventValidation.errors.map(
        (error) => `${path}.events[${eventIndex}].${error}`,
      ));
      if (eventValue?.sequence !== eventIndex) {
        errors.push(`${path}.events[${eventIndex}].sequence: expected ${eventIndex}`);
      }
      if (eventValue?.runId !== runId) {
        errors.push(`${path}.events[${eventIndex}].runId: does not match record`);
      }
    }
    if (
      entry.events[0]?.revision
        !== entry.record?.provenance?.derivation?.startRevision
    ) {
      errors.push(
        `${path}.events[0].revision: does not match record derivation startRevision`,
      );
    }
    if (entry.events.at(-1)?.revision !== entry.record?.revision) {
      errors.push(
        `${path}.events[${entry.events.length - 1}].revision: `
          + 'does not match record result revision',
      );
    }
    if (
      entry.record?.provenance?.derivation !== undefined
      && !sameValue(eventSetDerivation(entry.events), entry.record.provenance.derivation)
    ) {
      errors.push(`${path}: event set does not match record derivation`);
    }
  }
  const sortedIds = [...recordIds].sort();
  if (!sameValue(value.records.map((entry) => entry.record?.recordId), sortedIds)) {
    errors.push('bundle.records: records must be sorted by recordId');
  }
  return { ok: errors.length === 0, errors };
}

export function canonicalMeasurementEvidenceBundle(value) {
  const validation = validateMeasurementEvidenceBundle(value);
  if (!validation.ok) {
    throw new Error(`invalid measurement evidence bundle: ${validation.errors.join('; ')}`);
  }
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

export function parseMeasurementEvidenceBundle(source) {
  if (
    typeof source !== 'string'
    || Buffer.byteLength(source) === 0
    || Buffer.byteLength(source) > MAX_EVIDENCE_BUNDLE_BYTES
  ) {
    return {
      ok: false,
      errors: [
        `measurement evidence bundle must be 1..${MAX_EVIDENCE_BUNDLE_BYTES} UTF-8 bytes`,
      ],
    };
  }
  let bundle;
  try {
    bundle = JSON.parse(source);
  } catch (error) {
    return {
      ok: false,
      errors: [`measurement evidence bundle JSON is invalid: ${error.message}`],
    };
  }
  const validation = validateMeasurementEvidenceBundle(bundle);
  if (!validation.ok) return { ...validation, bundle };
  if (canonicalMeasurementEvidenceBundle(bundle) !== source) {
    return {
      ok: false,
      errors: [
        'measurement evidence bundle must use canonical unambiguous serialization',
      ],
      bundle,
    };
  }
  return { ok: true, errors: [], bundle };
}

function readOwnedArtifact(path, maximum, label) {
  const target = resolve(path);
  const parent = dirname(target);
  if (realpathSync(parent) !== parent) {
    throw new Error(`${label} parent must not traverse a symbolic link`);
  }
  const descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(descriptor);
    const mode = info.mode & 0o777;
    if (
      !info.isFile()
      || info.nlink !== 1
      || info.size < 1
      || info.size > maximum
      // Reject only what lets another account rewrite the policy. A fixed
      // 600/640/644 allowlist made verification depend on the checkout umask:
      // git does not track the group-write bit, so the same commit passed under
      // umask 022 and failed under 002.
      || (mode & 0o002) !== 0
      || (typeof process.getuid === 'function' && info.uid !== process.getuid())
    ) {
      throw new Error(
        `expected an owned regular bounded non-world-writable ${label} file`,
      );
    }
    return readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}

function readBudgetPolicyFile(path) {
  return readOwnedArtifact(path, MAX_POLICY_BYTES, 'budget policy');
}

export function loadMeasurementEvidenceBundleAt(
  path,
  expectedSha256,
  expectedRecordIds,
) {
  if (
    !HASH_RE.test(expectedSha256 ?? '')
    || !Array.isArray(expectedRecordIds)
    || expectedRecordIds.length === 0
    || expectedRecordIds.some((recordId) => !UUID_RE.test(recordId ?? ''))
    || new Set(expectedRecordIds).size !== expectedRecordIds.length
  ) {
    return {
      ok: false,
      records: [],
      errors: ['portable evidence load requires a sha256 and unique record UUIDs'],
    };
  }
  let source;
  try {
    source = readOwnedArtifact(
      path,
      MAX_EVIDENCE_BUNDLE_BYTES,
      'measurement evidence bundle',
    );
  } catch (error) {
    return { ok: false, records: [], errors: [error.message] };
  }
  const actualSha256 = createHash('sha256').update(source).digest('hex');
  if (actualSha256 !== expectedSha256) {
    return {
      ok: false,
      records: [],
      errors: ['measurement evidence bundle does not match policy sha256'],
    };
  }
  const parsed = parseMeasurementEvidenceBundle(source);
  if (!parsed.ok) return { ok: false, records: [], errors: parsed.errors };
  const expected = [...expectedRecordIds].sort();
  const actual = parsed.bundle.records.map((entry) => entry.record.recordId);
  if (!sameValue(expected, actual)) {
    return {
      ok: false,
      records: [],
      errors: ['measurement evidence bundle IDs do not exactly match active policy IDs'],
    };
  }
  const records = [];
  for (const [index, entry] of parsed.bundle.records.entries()) {
    entry.events.forEach((eventValue) => TRUSTED_EVENTS.add(eventValue));
    const replay = deriveMeasurementFromEvents(entry.events, entry.record.recordId);
    if (!replay.ok) {
      return {
        ok: false,
        records: [],
        errors: replay.errors.map((error) =>
          `bundle.records[${index}] replay: ${error}`),
      };
    }
    if (!sameValue(recordContent(entry.record), replay.record)) {
      return {
        ok: false,
        records: [],
        errors: [`bundle.records[${index}]: aggregate does not replay from raw events`],
      };
    }
    trustRecord(entry.record);
    markTrustedDerivedRecord(entry.record, replay.derivation);
    records.push(entry.record);
  }
  const recordSet = validateRecordSet(records);
  if (!recordSet.ok) return { ok: false, records: [], errors: recordSet.errors };
  return { ok: true, records, sha256: actualSha256, errors: [] };
}

export function exportMeasurementEvidenceBundle(recordIds, directory) {
  if (
    !Array.isArray(recordIds)
    || recordIds.length === 0
    || recordIds.length > MAX_STORE_RECORDS
    || recordIds.some((recordId) => !UUID_RE.test(recordId ?? ''))
    || new Set(recordIds).size !== recordIds.length
  ) {
    return { ok: false, errors: ['recordIds: expected unique bounded UUID v4 values'] };
  }
  const stored = readMeasurements(directory);
  if (!stored.ok) return { ok: false, errors: stored.errors };
  const byId = new Map(stored.records.map((recordValue) => [recordValue.recordId, recordValue]));
  const missing = recordIds.filter((recordId) => !byId.has(recordId));
  if (missing.length > 0) {
    return { ok: false, errors: [`missing authenticated records: ${missing.join(', ')}`] };
  }
  const records = [];
  for (const recordId of [...recordIds].sort()) {
    const recordValue = byId.get(recordId);
    if (!isTrustedDerivedRecord(recordValue)) {
      return {
        ok: false,
        errors: [`${recordId}: only replay-verified event-derived records can be exported`],
      };
    }
    const loaded = readMeasurementEvents(directory, recordValue.observation.runId);
    if (!loaded.ok) return { ok: false, errors: loaded.errors };
    records.push({ record: recordValue, events: loaded.events });
  }
  const bundle = {
    version: MEASUREMENT_EVIDENCE_BUNDLE_VERSION,
    kind: 'autoloop-measurement-evidence',
    createdAt: new Date().toISOString(),
    records,
  };
  const validation = validateMeasurementEvidenceBundle(bundle);
  if (!validation.ok) return validation;
  const source = canonicalMeasurementEvidenceBundle(bundle);
  if (Buffer.byteLength(source) > MAX_EVIDENCE_BUNDLE_BYTES) {
    return {
      ok: false,
      errors: [`measurement evidence bundle exceeds ${MAX_EVIDENCE_BUNDLE_BYTES} bytes`],
    };
  }
  return {
    ok: true,
    bundle,
    source,
    sha256: createHash('sha256').update(source).digest('hex'),
  };
}

export function checkBudgetPolicyAt(policyPath, evidenceRoot = GIT_CONTEXT) {
  let parsed;
  try {
    parsed = parseBudgetPolicy(readBudgetPolicyFile(policyPath));
  } catch (error) {
    return {
      ok: false,
      status: 'invalid',
      passed: false,
      errors: [`budget policy read failed: ${error.message}`],
      evaluations: [],
    };
  }
  if (!parsed.ok) {
    return {
      ok: false,
      status: 'invalid',
      passed: false,
      errors: parsed.errors,
      evaluations: [],
    };
  }
  if (parsed.policy.status === 'pending-evidence') {
    return evaluateBudgetPolicy(parsed.policy, []);
  }
  const expectedRecordIds = parsed.policy.budgets.flatMap((entry) => [
    ...entry.baselineRecordIds,
    ...entry.currentRecordIds,
  ]);
  const portable = loadMeasurementEvidenceBundleAt(
    resolve(evidenceRoot, parsed.policy.evidenceBundle.path),
    parsed.policy.evidenceBundle.sha256,
    expectedRecordIds,
  );
  if (!portable.ok) {
    return {
      ok: false,
      status: 'refused',
      passed: false,
      errors: portable.errors,
      evaluations: [],
    };
  }
  return evaluateBudgetPolicy(parsed.policy, portable.records);
}

function ensureMeasurementDirectory(directory, create = true) {
  const target = resolve(directory);
  if (create) mkdirSync(target, { recursive: true, mode: 0o700 });
  const info = lstatSync(target);
  if (
    !info.isDirectory()
    || info.isSymbolicLink()
    || realpathSync(target) !== target
    || (info.mode & 0o777) !== 0o700
    || (typeof process.getuid === 'function' && info.uid !== process.getuid())
  ) {
    throw new Error('measurement store must be a real directory');
  }
  return target;
}

function fsyncDirectory(directory) {
  const descriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function processStatus(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
    if (fields[0] && fields[19]) {
      return { identity: `proc:${fields[19]}`, state: fields[0] };
    }
  } catch {}
  let state = null;
  try {
    state = execFileSync('ps', ['-p', String(pid), '-o', 'stat='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    }).trim();
  } catch {}
  let identity = null;
  try {
    const started = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    }).trim();
    if (started) identity = `ps:${started}`;
  } catch {}
  return { identity, state: state || null };
}

function processIdentity(pid) {
  return processStatus(pid).identity;
}

function processOwnerAlive(
  owner,
  inspectProcess = processStatus,
  signalProcess = (pid) => process.kill(pid, 0),
) {
  if (!plainObject(owner) || !Number.isInteger(owner.pid) || owner.pid < 1) return null;
  try {
    signalProcess(owner.pid);
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    return null;
  }
  let status;
  try {
    status = inspectProcess(owner.pid);
  } catch {
    return null;
  }
  if (status?.state?.startsWith('Z')) return false;
  const identity = status?.identity ?? null;
  if (owner.processIdentity !== null && identity !== null) {
    return owner.processIdentity === identity;
  }
  return true;
}

function readStoreLockOid() {
  const symbolic = gitSpawn(
    ['symbolic-ref', '--quiet', '--no-recurse', STORE_LOCK_REF],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  if (symbolic.status === 0) {
    throw new Error('measurement store lock must not be symbolic');
  }
  if (symbolic.status !== 1) {
    throw new Error('cannot inspect measurement store lock');
  }
  const result = gitSpawn(
    [
      'for-each-ref',
      '--format=%(refname)%09%(objectname)%09%(symref)',
      STORE_LOCK_REF,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  if (result.status !== 0) throw new Error('cannot inspect measurement store lock');
  const matching = result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'))
    .filter(([refname]) => refname === STORE_LOCK_REF);
  if (matching.length === 0) return null;
  if (matching.length !== 1 || matching[0].length !== 3) {
    throw new Error('measurement store lock inspection is ambiguous');
  }
  const [, oid, symbolicTarget] = matching[0];
  if (symbolicTarget) {
    throw new Error('measurement store lock must not be symbolic');
  }
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/u.test(oid)) {
    throw new Error('measurement store lock has an invalid object ID');
  }
  return oid;
}

function readStoreLockOwner(oid) {
  try {
    const owner = JSON.parse(gitExec(['cat-file', 'blob', oid], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    }));
    const errors = [];
    if (!exactObject(
      errors,
      'lockOwner',
      owner,
      [
        'version',
        'pid',
        'processIdentity',
        'nonce',
        'storeFingerprint',
        'createdAt',
      ],
    )) throw new Error('shape');
    if (
      owner.version !== 1
      || !Number.isInteger(owner.pid)
      || owner.pid < 1
      || !(owner.processIdentity === null || typeof owner.processIdentity === 'string')
      || !UUID_RE.test(owner.nonce ?? '')
      || !HASH_RE.test(owner.storeFingerprint ?? '')
      || !canonicalTimestamp(owner.createdAt)
    ) throw new Error('fields');
    return owner;
  } catch {
    throw new Error('measurement store lock owner metadata is invalid');
  }
}

function compareAndSwapStoreLock(newOid, expectedOid) {
  const args = newOid === null
    ? ['update-ref', '--no-deref', '-d', STORE_LOCK_REF, expectedOid]
    : ['update-ref', '--no-deref', STORE_LOCK_REF, newOid, expectedOid];
  return gitSpawn(args, {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: 2_000,
  }).status === 0;
}

function updateStoreLock(newOid, expectedOid) {
  const existingOid = readStoreLockOid();
  const absentOid = '0'.repeat(expectedOid.length);
  if ((existingOid ?? absentOid) !== expectedOid) return false;
  return compareAndSwapStoreLock(newOid, expectedOid);
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function acquireStoreLock(directory) {
  const owner = {
    version: 1,
    pid: process.pid,
    processIdentity: processIdentity(process.pid),
    nonce: randomUUID(),
    storeFingerprint: fingerprint(resolve(directory)),
    createdAt: new Date().toISOString(),
  };
  const payload = `${JSON.stringify(owner)}\n`;
  const ownedOid = gitExec(['hash-object', '-w', '--stdin'], {
    encoding: 'utf8',
    input: payload,
    stdio: ['pipe', 'pipe', 'ignore'],
    timeout: 2_000,
  }).trim();
  const zeroOid = '0'.repeat(ownedOid.length);
  const deadline = Date.now() + STORE_LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const existingOid = readStoreLockOid();
    if (existingOid === null) {
      if (updateStoreLock(ownedOid, zeroOid)) return { ownedOid, owner };
    } else {
      const existingOwner = readStoreLockOwner(existingOid);
      const alive = processOwnerAlive(existingOwner);
      if (alive === null) throw new Error('measurement store lock owner cannot be verified');
      if (!alive && updateStoreLock(ownedOid, existingOid)) return { ownedOid, owner };
    }
    sleepSync(20);
  }
  throw new Error('measurement store lock timed out');
}

function withStoreLock(directory, operation) {
  const lock = acquireStoreLock(directory);
  let operationError;
  try {
    return operation();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (!updateStoreLock(null, lock.ownedOid) && operationError === undefined) {
      throw new Error('measurement store lock ownership changed before release');
    }
  }
}

function recoverPublications(directory) {
  const names = readdirSync(directory);
  const temporaries = names.filter((name) => /^\.tmp-[0-9a-f-]{36}$/u.test(name));
  let changed = false;
  for (const temporaryName of temporaries) {
    const temporaryPath = join(directory, temporaryName);
    const temporary = lstatSync(temporaryPath);
    if (
      !temporary.isFile()
      || temporary.isSymbolicLink()
      || (temporary.mode & 0o777) !== 0o600
      || (typeof process.getuid === 'function' && temporary.uid !== process.getuid())
    ) throw new Error(`${temporaryName}: invalid publication temporary`);
    const finals = names.filter((name) => {
      if (name.startsWith('.tmp-')) return false;
      try {
        const candidate = lstatSync(join(directory, name));
        return candidate.dev === temporary.dev && candidate.ino === temporary.ino;
      } catch {
        return false;
      }
    });
    if (temporary.nlink === 1 && finals.length === 0) {
      unlinkSync(temporaryPath);
      changed = true;
    } else if (temporary.nlink === 2 && finals.length === 1) {
      unlinkSync(temporaryPath);
      changed = true;
    } else {
      throw new Error(`${temporaryName}: ambiguous publication state`);
    }
  }
  if (changed) fsyncDirectory(directory);
}

function readDescriptor(path, maximum, expectedMode) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(descriptor);
    if (
      !info.isFile()
      || info.nlink !== 1
      || info.size > maximum
      || (info.mode & 0o777) !== expectedMode
      || (typeof process.getuid === 'function' && info.uid !== process.getuid())
    ) {
      throw new Error(`expected owned regular mode-${expectedMode.toString(8)} bounded file`);
    }
    return readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}

function atomicCreate(path, payload, mode) {
  const directory = resolve(path, '..');
  const temporary = join(directory, `.tmp-${randomUUID()}`);
  let descriptor;
  let linked = false;
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      mode,
    );
    fchmodSync(descriptor, mode);
    writeFileSync(descriptor, payload, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, path);
    linked = true;
    if (
      process.env.AUTOLOOP_MEASUREMENT_SELF_TEST === '1'
      && path.endsWith('.json')
    ) sleepSync(500);
    unlinkSync(temporary);
    fsyncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (linked) {
      try {
        unlinkSync(path);
      } catch {}
    }
    try {
      unlinkSync(temporary);
    } catch {}
    throw error;
  }
}

function measurementStoreAuthority(directory, create = false) {
  const target = ensureMeasurementDirectory(directory, create);
  recoverPublications(target);
  const keyPath = join(target, STORE_KEY_FILE);
  if (create) {
    let keyExists = true;
    try {
      lstatSync(keyPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      keyExists = false;
    }
    if (!keyExists) {
      if (readdirSync(target).length !== 0) {
        throw new Error('measurement authority is missing from a non-empty store');
      }
      const authority = {
        storeId: randomUUID(),
        key: randomBytes(32).toString('hex'),
      };
      atomicCreate(keyPath, `${JSON.stringify(authority)}\n`, 0o600);
    }
  }
  const authority = JSON.parse(readDescriptor(keyPath, 1024, 0o600));
  if (
    !plainObject(authority)
    || !UUID_RE.test(authority.storeId ?? '')
    || !HASH_RE.test(authority.key ?? '')
    || Object.keys(authority).sort().join(',') !== 'key,storeId'
  ) {
    throw new Error('measurement store authority is invalid');
  }
  return { target, ...authority };
}

function provenanceMac(provenance, key) {
  return createHmac('sha256', Buffer.from(key, 'hex')).update(JSON.stringify(canonical({
    kind: provenance.kind,
    storeId: provenance.storeId,
    authenticatedAt: provenance.authenticatedAt,
    contentFingerprint: provenance.contentFingerprint,
    observationFingerprint: provenance.observationFingerprint,
    capture: provenance.capture,
    ...(provenance.derivation === undefined
      ? {}
      : { derivation: provenance.derivation }),
  }))).digest('hex');
}

function authenticateRecord(recordValue, authority, authenticatedAt, derivation = null) {
  const authenticated = {
    ...recordContent(recordValue),
    provenance: {
      kind: 'tool-authenticated',
      storeId: authority.storeId,
      authenticatedAt,
      contentFingerprint: recordContentFingerprint(recordValue),
      observationFingerprint: observationFingerprint(recordValue),
      capture: {
        revisionSource: 'live-git-head',
        timeSource: 'tool-clock',
        checkpointSource: 'operator-declared',
        observationSource:
          derivation === null
            ? 'run-record-declared'
            : 'derived-authenticated-events',
      },
      ...(derivation === null
        ? {}
        : { derivation: structuredClone(derivation) }),
      mac: '',
    },
  };
  authenticated.provenance.mac = provenanceMac(authenticated.provenance, authority.key);
  return authenticated;
}

function verifyAuthentication(recordValue, authority) {
  if (recordValue.provenance?.storeId !== authority.storeId) return false;
  const expected = provenanceMac(recordValue.provenance, authority.key);
  const actual = recordValue.provenance.mac;
  return (
    HASH_RE.test(actual ?? '')
    && timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'))
  );
}

function eventProvenanceMac(provenance, key) {
  return createHmac('sha256', Buffer.from(key, 'hex'))
    .update(JSON.stringify(canonical({
      kind: provenance.kind,
      storeId: provenance.storeId,
      contentFingerprint: provenance.contentFingerprint,
      capture: provenance.capture,
    })))
    .digest('hex');
}

function verifyEventAuthentication(eventValue, authority) {
  if (eventValue.provenance?.storeId !== authority.storeId) return false;
  const actual = eventValue.provenance.mac;
  if (!HASH_RE.test(actual ?? '')) return false;
  const expected = eventProvenanceMac(eventValue.provenance, authority.key);
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}

function eventDirectory(authority, runId, create = false) {
  const root = join(authority.target, 'events');
  const run = join(root, runId);
  if (!create) {
    try {
      lstatSync(run);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }
  ensureMeasurementDirectory(root, create);
  return ensureMeasurementDirectory(run, create);
}

function readMeasurementEventsLocked(authority, runId) {
  if (!UUID_RE.test(runId ?? '')) {
    return { ok: false, events: [], errors: ['runId: expected UUID v4'] };
  }
  let directory;
  try {
    directory = eventDirectory(authority, runId, false);
    if (directory === null) return { ok: true, events: [], errors: [] };
  } catch (error) {
    return {
      ok: false,
      events: [],
      errors: [`measurement event store read failed: ${error.message}`],
    };
  }
  const errors = [];
  const events = [];
  let names;
  try {
    names = readdirSync(directory).sort();
  } catch (error) {
    return {
      ok: false,
      events,
      errors: [`measurement event store read failed: ${error.message}`],
    };
  }
  if (names.length > MAX_RUN_EVENTS) {
    return {
      ok: false,
      events,
      errors: [`measurement event store exceeds ${MAX_RUN_EVENTS} events`],
    };
  }
  for (const [index, name] of names.entries()) {
    const match = name.match(EVENT_FILE_RE);
    if (!match || !UUID_RE.test(match[2])) {
      errors.push(`${name}: filename is not a measurement event`);
      continue;
    }
    try {
      const eventValue = JSON.parse(
        readDescriptor(join(directory, name), MAX_RECORD_BYTES, 0o600),
      );
      const validation = validateMeasurementEventRecord(eventValue);
      if (!validation.ok) {
        errors.push(`${name}: ${validation.errors.join('; ')}`);
      } else if (
        Number(match[1]) !== index
        || eventValue.sequence !== index
        || eventValue.eventId !== match[2]
        || eventValue.runId !== runId
      ) {
        errors.push(`${name}: filename, sequence, or run identity mismatch`);
      } else if (!verifyEventAuthentication(eventValue, authority)) {
        errors.push(`${name}: authentication failed`);
      } else {
        TRUSTED_EVENTS.add(eventValue);
        events.push(eventValue);
      }
    } catch (error) {
      errors.push(`${name}: ${error.message}`);
    }
  }
  return { ok: errors.length === 0, events, errors };
}

export function readMeasurementEvents(directory, runId) {
  const target = resolve(directory);
  try {
    lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, events: [], errors: [] };
    return {
      ok: false,
      events: [],
      errors: [`measurement event store read failed: ${error.message}`],
    };
  }
  try {
    ensureMeasurementDirectory(target, false);
    return withStoreLock(target, () => {
      const authority = measurementStoreAuthority(target, false);
      return readMeasurementEventsLocked(authority, runId);
    });
  } catch (error) {
    return {
      ok: false,
      events: [],
      errors: [`measurement event store read failed: ${error.message}`],
    };
  }
}

function persistMeasurementEvent(
  input,
  directory,
  payloadSource = 'producer-contract-verified',
) {
  const validation = validateMeasurementEventInput(input);
  if (!validation.ok) return { ok: false, errors: validation.errors };
  if (!EVENT_PAYLOAD_SOURCES.has(payloadSource)) {
    return { ok: false, errors: ['event persistence failed: invalid payload source'] };
  }
  let revision;
  try {
    revision = gitExec(['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    }).trim();
  } catch (error) {
    return {
      ok: false,
      errors: [`event persistence failed: cannot bind live HEAD: ${error.message}`],
    };
  }
  let target;
  try {
    target = ensureMeasurementDirectory(directory, true);
  } catch (error) {
    return { ok: false, errors: [`event persistence failed: ${error.message}`] };
  }
  const startedAt = Date.now();
  try {
    return withStoreLock(target, () => {
      const authority = measurementStoreAuthority(target, true);
      const existing = readMeasurementEventsLocked(authority, input.runId);
      if (!existing.ok) throw new Error(existing.errors.join('; '));
      if (
        (existing.events.length === 0 && input.kind !== 'run-start')
        || (existing.events.length > 0 && input.kind === 'run-start')
        || existing.events.at(-1)?.kind === 'run-finish'
      ) {
        throw new Error('event append violates the one-start/one-finish run boundary');
      }
      const sequence = existing.events.length;
      const eventId = randomUUID();
      const capturedAt = new Date().toISOString();
      const eventValue = {
        version: MEASUREMENT_EVENT_VERSION,
        eventId,
        runId: input.runId,
        sequence,
        capturedAt,
        revision,
        kind: input.kind,
        payload: structuredClone(input.payload),
        provenance: {
          kind: 'tool-authenticated-event',
          storeId: authority.storeId,
          contentFingerprint: '',
          capture: {
            revisionSource: 'live-git-head',
            timeSource: 'tool-clock',
            payloadSource,
            durationMs: Date.now() - startedAt,
          },
          mac: '',
        },
      };
      eventValue.provenance.contentFingerprint = eventContentFingerprint(eventValue);
      eventValue.provenance.mac =
        eventProvenanceMac(eventValue.provenance, authority.key);
      const eventValidation = validateMeasurementEventRecord(eventValue);
      if (!eventValidation.ok) throw new Error(eventValidation.errors.join('; '));
      const directoryPath = eventDirectory(authority, input.runId, true);
      const path = join(
        directoryPath,
        `event-${String(sequence).padStart(6, '0')}-${eventId}.json`,
      );
      atomicCreate(path, `${JSON.stringify(eventValue)}\n`, 0o600);
      TRUSTED_EVENTS.add(eventValue);
      return {
        ok: true,
        path,
        eventId,
        sequence,
        capturedAt,
        contentFingerprint: eventValue.provenance.contentFingerprint,
      };
    });
  } catch (error) {
    return { ok: false, errors: [`event persistence failed: ${error.message}`] };
  }
}

function persistMeasurementLocked(recordValue, authority, authenticatedAt, derivation) {
  const authenticated = authenticateRecord(
    recordValue,
    authority,
    authenticatedAt,
    derivation,
  );
  const path = join(authority.target, `${recordValue.recordId}.json`);
  const payload = `${JSON.stringify(authenticated)}\n`;
  if (Buffer.byteLength(payload) > MAX_RECORD_BYTES) {
    throw new Error(`record exceeds ${MAX_RECORD_BYTES} bytes`);
  }
  atomicCreate(path, payload, 0o600);
  return {
    ok: true,
    path,
    contentFingerprint: authenticated.provenance.contentFingerprint,
  };
}

export function persistMeasurement(recordValue, directory) {
  const raw = recordContent(recordValue);
  const derivation = DERIVED_RECORDS.get(recordValue) ?? null;
  let liveRevision;
  try {
    liveRevision = gitExec(['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    }).trim();
  } catch (error) {
    return { ok: false, errors: [`record persistence failed: cannot bind live HEAD: ${error.message}`] };
  }
  if (raw.checkpoint === 'legacy-workflow') {
    return {
      ok: false,
      errors: ['record persistence failed: legacy import has no authenticated path'],
    };
  }
  if (raw.revision !== liveRevision) {
    return {
      ok: false,
      errors: [`record persistence failed: revision must equal live HEAD ${liveRevision}`],
    };
  }
  const authenticatedAt = new Date().toISOString();
  if (derivation === null) raw.capturedAt = authenticatedAt;
  const validation = validateMeasurement(raw);
  if (!validation.ok) return { ok: false, errors: validation.errors };
  let target;
  try {
    target = ensureMeasurementDirectory(directory, true);
  } catch (error) {
    return { ok: false, errors: [`record persistence failed: ${error.message}`] };
  }
  try {
    return withStoreLock(target, () => {
      const authority = measurementStoreAuthority(target, true);
      return persistMeasurementLocked(
        raw,
        authority,
        authenticatedAt,
        derivation,
      );
    });
  } catch (error) {
    return { ok: false, errors: [`record persistence failed: ${error.message}`] };
  }
}

export function finalizeMeasurementRun(input, directory) {
  const graph = validateDataGraph(input);
  const errors = graph.ok ? [] : [...graph.errors];
  if (
    graph.ok
    && exactObject(errors, 'finalization', input, ['runId', 'recordId'])
  ) {
    if (!UUID_RE.test(input.runId ?? '')) {
      errors.push('finalization.runId: expected UUID v4');
    }
    if (!UUID_RE.test(input.recordId ?? '')) {
      errors.push('finalization.recordId: expected UUID v4');
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  let liveRevision;
  try {
    liveRevision = gitExec(['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    }).trim();
  } catch (error) {
    return {
      ok: false,
      errors: [`run finalization failed: cannot bind live HEAD: ${error.message}`],
    };
  }
  let target;
  try {
    target = ensureMeasurementDirectory(directory, false);
  } catch (error) {
    return { ok: false, errors: [`run finalization failed: ${error.message}`] };
  }
  try {
    return withStoreLock(target, () => {
      const authority = measurementStoreAuthority(target, false);
      const loaded = readMeasurementEventsLocked(authority, input.runId);
      if (!loaded.ok) throw new Error(loaded.errors.join('; '));
      if (loaded.events.length === 0) throw new Error('run has no authenticated events');
      if (loaded.events.at(-1)?.kind !== 'run-finish') {
        throw new Error('run has not retained a finish event');
      }
      if (loaded.events.at(-1).revision !== liveRevision) {
        throw new Error(`run finish must equal live HEAD ${liveRevision}`);
      }
      const derived = deriveMeasurementFromEvents(loaded.events, input.recordId);
      if (!derived.ok) throw new Error(derived.errors.join('; '));
      const validation = validateMeasurement(derived.record);
      if (!validation.ok) throw new Error(validation.errors.join('; '));
      const result = persistMeasurementLocked(
        derived.record,
        authority,
        new Date().toISOString(),
        derived.derivation,
      );
      return {
        ...result,
        runId: input.runId,
        recordId: input.recordId,
        eventCount: derived.derivation.eventCount,
        eventSetFingerprint: derived.derivation.eventSetFingerprint,
      };
    });
  } catch (error) {
    return { ok: false, errors: [`run finalization failed: ${error.message}`] };
  }
}

export function readMeasurements(directory) {
  const records = [];
  const errors = [];
  const target = resolve(directory);
  try {
    lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, records, errors };
    return { ok: false, records, errors: [`measurement store read failed: ${error.message}`] };
  }
  try {
    ensureMeasurementDirectory(target, false);
    return withStoreLock(target, () => readMeasurementsLocked(target));
  } catch (error) {
    return { ok: false, records, errors: [`measurement store read failed: ${error.message}`] };
  }
}

function readMeasurementsLocked(target) {
  const records = [];
  const errors = [];
  let names;
  let authority;
  try {
    recoverPublications(target);
    if (readdirSync(target).length === 0) return { ok: true, records, errors };
    authority = measurementStoreAuthority(target, false);
    names = readdirSync(target).filter((name) => name.endsWith('.json')).sort();
    if (names.length > MAX_STORE_RECORDS) {
      return { ok: false, records, errors: [`measurement store exceeds ${MAX_STORE_RECORDS} records`] };
    }
  } catch (error) {
    return { ok: false, records, errors: [`measurement store read failed: ${error.message}`] };
  }
  for (const name of names) {
    if (!UUID_RE.test(name.replace(/\.json$/u, ''))) {
      errors.push(`${name}: filename is not a measurement UUID`);
      continue;
    }
    try {
      const value = JSON.parse(readDescriptor(join(target, name), MAX_RECORD_BYTES, 0o600));
      const validation = validateMeasurement(value);
      if (!validation.ok) {
        errors.push(`${name}: ${validation.errors.join('; ')}`);
      } else if (`${value.recordId}.json` !== name) {
        errors.push(`${name}: filename does not match recordId`);
      } else if (!verifyAuthentication(value, authority)) {
        errors.push(`${name}: authentication failed`);
      } else {
        const derivation = value.provenance.derivation;
        if (derivation === undefined) {
          trustRecord(value);
          records.push(value);
          continue;
        }
        const loaded = readMeasurementEventsLocked(authority, derivation.runId);
        if (!loaded.ok) {
          errors.push(`${name}: raw event replay failed: ${loaded.errors.join('; ')}`);
          continue;
        }
        const replayDerivation = eventSetDerivation(loaded.events);
        if (!sameValue(replayDerivation, derivation)) {
          errors.push(`${name}: retained raw event set does not match derivation`);
          continue;
        }
        const replay = deriveMeasurementFromEvents(loaded.events, value.recordId);
        if (!replay.ok) {
          errors.push(`${name}: raw event replay failed: ${replay.errors.join('; ')}`);
          continue;
        }
        if (!sameValue(recordContent(value), replay.record)) {
          errors.push(`${name}: aggregate does not replay from retained raw events`);
          continue;
        }
        trustRecord(value);
        markTrustedDerivedRecord(value, derivation);
        records.push(value);
      }
    } catch (error) {
      errors.push(`${name}: ${error.message}`);
    }
  }
  return { ok: errors.length === 0, records, errors };
}

export function summarizeMeasurementStore(directory) {
  const stored = readMeasurements(directory);
  if (!stored.ok) return { ...stored, recordCount: stored.records.length };
  const summary = summarizeMeasurements(stored.records);
  return {
    ok: summary.invalid.length === 0,
    recordCount: stored.records.length,
    records: stored.records,
    errors: summary.invalid.flatMap((entry) => entry.errors),
    summary,
  };
}

function observed(value) {
  return { status: 'observed', value };
}

function unavailable(reason = 'fixture provider did not expose this field') {
  return { status: 'unavailable', reason };
}

let cachedFixtureRevision;

function fixtureRevision() {
  cachedFixtureRevision ??= gitExec(['rev-parse', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  }).trim();
  return cachedFixtureRevision;
}

function fixtureSegment({
  id,
  stage,
  round = 1,
  requestedRoute = 'claude.codex-exec',
  actualRoute = requestedRoute,
  degradation = null,
  totalMs = 10,
  promptTokens = 10,
  contextBytes = 100,
  effectiveLane = 'full',
  laneProofFingerprint = 'e'.repeat(64),
}) {
  return {
    id,
    stage,
    round,
    role: expectedRole(stage),
    effectiveLane,
    laneProofFingerprint,
    requestedRoute,
    actualRoute,
    adapter: actualRoute,
    degradation,
    timing: {
      totalMs,
      activeMs: totalMs,
      engineWaitMs: 0,
      ciWaitMs: 0,
      humanWaitMs: 0,
      steps: { execute: totalMs },
    },
    telemetry: {
      provider: observed(actualRoute.includes('codex') ? 'openai' : 'anthropic'),
      model: observed(actualRoute.includes('codex') ? 'gpt-fixture' : 'claude-fixture'),
      engine: observed(actualRoute),
      promptTokens: observed(promptTokens),
      cachedInputTokens: observed(0),
      outputTokens: observed(2),
      reasoningTokens: unavailable(),
      contextBytes: observed(contextBytes),
      costUsd: unavailable(),
    },
  };
}

function fixtureRecord(totalMs = 100, overrides = {}) {
  const external = 'claude.codex-exec';
  const native = 'claude.native';
  const segments = [
    fixtureSegment({ id: 'premise', stage: 'premise', requestedRoute: native, totalMs: 5 }),
    fixtureSegment({ id: 'selection', stage: 'selection', requestedRoute: native, totalMs: 5 }),
    fixtureSegment({ id: 'planning', stage: 'planning', requestedRoute: native, totalMs: 5 }),
    fixtureSegment({ id: 'plan', stage: 'plan-review', requestedRoute: external, totalMs: 5 }),
    fixtureSegment({ id: 'claim', stage: 'claim', requestedRoute: native, totalMs: 5 }),
    fixtureSegment({ id: 'write', stage: 'implementation', requestedRoute: external, totalMs: 5 }),
    fixtureSegment({ id: 'simplify', stage: 'simplify', requestedRoute: native, totalMs: 5 }),
    fixtureSegment({ id: 'diff-review', stage: 'diff-review', requestedRoute: native, totalMs: 5 }),
    fixtureSegment({ id: 'review-1', stage: 'code-review', requestedRoute: external, totalMs: 5 }),
    fixtureSegment({
      id: 'review-2',
      stage: 'code-review',
      round: 2,
      requestedRoute: native,
      totalMs: 5,
    }),
    fixtureSegment({ id: 'gate', stage: 'gate', requestedRoute: native, totalMs: 5 }),
    fixtureSegment({ id: 'delivery', stage: 'delivery', requestedRoute: native, totalMs: 5 }),
  ];
  const sum = (key) => segments.reduce(
    (value, segment) => value + (observationValue(segment.telemetry[key]) ?? 0),
    0,
  );
  return {
    version: MEASUREMENT_VERSION,
    recordId: '123e4567-e89b-42d3-a456-426614174000',
    capturedAt: '2026-07-24T00:00:00.000Z',
    revision: fixtureRevision(),
    workload: 'fixture-full',
    checkpoint: 'safe-system',
    comparisonContextFingerprint: '8'.repeat(64),
    checkpointEndpointFingerprint: '7'.repeat(64),
    activeHost: 'claude',
    selector: 'codex',
    requestedEngine: 'codex',
    requestedRoute: external,
    intentProvenance: INTENT_PROVENANCE,
    intent: { flow: 'dev', source: 'invocation' },
    lane: 'full',
    mergePolicy: 'manual',
    baseFreshnessStrategy: 'direct-strict',
    configFingerprint: 'b'.repeat(64),
    capabilityFingerprint: 'c'.repeat(64),
    outageFingerprint: 'd'.repeat(64),
    outageTransition: null,
    instrumentationOverhead: {
      durationMs: 2,
      githubApi: 0,
      subprocesses: 1,
      remoteMutations: 0,
    },
    segments,
    observation: {
      runId: 'f23e4567-e89b-42d3-a456-426614174000',
      unitId: 'issue-1',
      runtimeRunFingerprint: '9'.repeat(64),
      terminalEvidenceFingerprint: 'a'.repeat(64),
    },
    unit: {
      timing: {
        timeToFirstSelectionMs: 10,
        totalMs,
        activeMs: totalMs - 30,
        engineWaitMs: 10,
        ciWaitMs: 10,
        humanWaitMs: 10,
        steps: { selection: 10, gate: 20 },
      },
      telemetry: {
        promptTokens: observed(sum('promptTokens')),
        cachedInputTokens: observed(sum('cachedInputTokens')),
        outputTokens: observed(sum('outputTokens')),
        reasoningTokens: unavailable(),
        contextBytes: observed(sum('contextBytes')),
        costUsd: unavailable(),
      },
      calls: { githubApi: 4, subprocesses: 7, remoteMutations: 1 },
      dispatch: {
        count: 4,
        durationMs: 20,
        reviewRounds: 2,
        findings: { critical: 0, major: 1, minor: 1 },
        rebuts: { accepted: 1, rejected: 0 },
      },
      outcomes: {
        terminal: { status: 'completed', stage: 'delivery', reason: null },
        gate: { result: 'first-pass', localGreenCiRed: false },
        recovery: { resumeKind: 'fresh', recoveryKind: 'not-needed', contextParks: 0 },
        overlap: {
          stagedAheadUnits: 1,
          utilizedUnits: 1,
          avoidedIdleWait: unavailable('no verified avoided-idle evidence'),
        },
        laneEffectiveness: {
          falseClassifications: 0,
          scopeDriftFallbacks: 0,
          avoidedEngineTime: unavailable('no verified avoided-engine evidence'),
        },
        avoidedRework: {
          partialClaimsResumed: 0,
          auditRecordsBackfilled: 0,
          duplicateScansAvoided: 1,
          falseDoctorFailuresPrevented: 0,
          avoidedTime: unavailable('no verified avoided-rework evidence'),
        },
      },
    },
    ...overrides,
    observation: {
      runId: 'f23e4567-e89b-42d3-a456-426614174000',
      unitId: 'issue-1',
      runtimeRunFingerprint: '9'.repeat(64),
      terminalEvidenceFingerprint: 'a'.repeat(64),
      ...(overrides.observation ?? {}),
    },
  };
}

function trustFixtureEvents(events) {
  for (const [index, eventValue] of events.entries()) {
    eventValue.sequence = index;
    eventValue.eventId =
      `923e4567-e89b-42d3-a456-${String(426614180000 + index).padStart(12, '0')}`;
    eventValue.provenance.contentFingerprint = eventContentFingerprint(eventValue);
    eventValue.provenance.mac = createHash('sha256')
      .update(`fixture-event-${index}-${eventValue.provenance.contentFingerprint}`)
      .digest('hex');
    TRUSTED_EVENTS.add(eventValue);
  }
  return events;
}

function fixtureTypedEvidence(runId, producer, type, subjectId, payload) {
  return evidenceFromTypedEnvelope({
    producer,
    type,
    subjectId,
    payload,
  }, runId);
}

function fixtureCommandResult(operationKind = 'subprocess') {
  return {
    version: 1,
    operationKind,
    status: 'exited',
    executableFingerprint: '1'.repeat(64),
    argumentsFingerprint: '2'.repeat(64),
    cwdFingerprint: '3'.repeat(64),
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:00.001Z',
    durationMs: 1,
    exitCode: 0,
    signal: null,
    stdout: { bytes: 0, sha256: fingerprint('') },
    stderr: { bytes: 0, sha256: fingerprint('') },
  };
}

function fixtureRuntimeContext(recordValue) {
  return {
    run: {
      version: 1,
      instanceFingerprint: recordValue.observation.runtimeRunFingerprint,
      authorization: '4'.repeat(64),
      configFingerprint: recordValue.configFingerprint,
      sessionFingerprint: '5'.repeat(64),
      activeHost: recordValue.activeHost,
      selector: recordValue.selector,
      requestedEngine: recordValue.requestedEngine,
      requestedRoute: recordValue.requestedRoute,
      intentProvenance: recordValue.intentProvenance,
      invocationFlow: recordValue.intent.flow,
    },
  };
}

function fixtureRuntimeReceipt(recordValue, segment) {
  const role = segment.stage === 'implementation' ? 'writer' : 'reviewer';
  const receipt = {
    version: 1,
    authorization: '7'.repeat(64),
    runInstanceFingerprint: recordValue.observation.runtimeRunFingerprint,
    configFingerprint: recordValue.configFingerprint,
    activeHost: recordValue.activeHost,
    selector: recordValue.selector,
    requestedEngine: recordValue.requestedEngine,
    requestedRoute: recordValue.requestedRoute,
    intentProvenance: recordValue.intentProvenance,
    actualRoute: segment.actualRoute,
    adapter: segment.adapter,
    invocationFlow: recordValue.intent.flow,
    effectiveLane: segment.effectiveLane,
    laneProofFingerprint: segment.laneProofFingerprint,
    capabilityFingerprint: recordValue.capabilityFingerprint,
    routeState: {
      fingerprint: recordValue.outageFingerprint,
      capabilityFingerprint: recordValue.capabilityFingerprint,
    },
    stage: segment.stage,
    round: segment.round,
    role,
    outageTransition: 'none',
    degradation: segment.degradation === null ? [] : [segment.degradation.code],
    reviewVerdicts: role === 'reviewer'
      ? [{
          verdict: {
            verdict: 'pass',
            findings: [],
            rebuts: [],
          },
        }]
      : [],
  };
  return { ...receipt, fingerprint: fingerprint(receipt) };
}

function fixtureAuthenticatedEvents(
  recordValue = fixtureRecord(),
  { preSelectionGapMs = 0 } = {},
) {
  const runId = recordValue.observation.runId;
  const startMs = Date.parse(recordValue.capturedAt);
  const events = [];
  const append = (kind, payload, capturedAtMs) => {
    events.push({
      version: MEASUREMENT_EVENT_VERSION,
      eventId: '',
      runId,
      sequence: 0,
      capturedAt: new Date(capturedAtMs).toISOString(),
      revision: recordValue.revision,
      kind,
      payload: structuredClone(payload),
      provenance: {
        kind: 'tool-authenticated-event',
        storeId: '323e4567-e89b-42d3-a456-426614174000',
        contentFingerprint: '',
        capture: {
          revisionSource: 'live-git-head',
          timeSource: 'tool-clock',
          payloadSource: 'producer-contract-verified',
          durationMs: 0,
        },
        mac: '',
      },
    });
  };
  append('run-start', {
    workload: recordValue.workload,
    checkpoint: recordValue.checkpoint,
    comparisonContextFingerprint: recordValue.comparisonContextFingerprint,
    checkpointEndpointFingerprint: recordValue.checkpointEndpointFingerprint,
    activeHost: recordValue.activeHost,
    selector: recordValue.selector,
    requestedEngine: recordValue.requestedEngine,
    requestedRoute: recordValue.requestedRoute,
    intentProvenance: recordValue.intentProvenance,
    intent: recordValue.intent,
    mergePolicy: recordValue.mergePolicy,
    baseFreshnessStrategy: recordValue.baseFreshnessStrategy,
    configFingerprint: recordValue.configFingerprint,
    runtimeBinding: fixtureTypedEvidence(
      runId,
      'runtime',
      'run-context',
      recordValue.observation.runtimeRunFingerprint,
      fixtureRuntimeContext(recordValue),
    ),
  }, startMs);
  let cursor = startMs;
  let unitContextAppended = false;
  for (const segment of recordValue.segments) {
    if (segment.stage === 'selection') cursor += preSelectionGapMs;
    if (
      !unitContextAppended
      && ['plan-review', 'implementation'].includes(segment.stage)
    ) {
      append('unit-context', {
        unitId: recordValue.observation.unitId,
        initialLane: recordValue.segments.find((candidate) =>
          DISPATCH_STAGES.has(candidate.stage)).effectiveLane,
        initialLaneProofFingerprint: recordValue.segments.find((candidate) =>
          DISPATCH_STAGES.has(candidate.stage)).laneProofFingerprint,
        planFingerprint: 'f'.repeat(64),
        capabilityFingerprint: recordValue.capabilityFingerprint,
        outageFingerprint: recordValue.outageFingerprint,
      }, cursor);
      unitContextAppended = true;
    }
    append('stage-start', {
      id: segment.id,
      stage: segment.stage,
      round: segment.round,
    }, cursor);
    if (segment.stage === 'premise') {
      append('operation', {
        stageId: segment.id,
        operationId: 'fixture-github-read',
        kind: 'github-api',
        action: 'read issue metadata',
        evidence: fixtureTypedEvidence(
          runId,
          'command-wrapper',
          'github-api-result',
          'fixture-github-read',
          fixtureCommandResult('github-api'),
        ),
      }, cursor);
    }
    if (DISPATCH_STAGES.has(segment.stage)) {
      const runtimeReceipt = fixtureRuntimeReceipt(recordValue, segment);
      append('dispatch', {
        stageId: segment.id,
        dispatchId: runtimeReceipt.fingerprint,
        runtimeReceipt: fixtureTypedEvidence(
          runId,
          'runtime',
          'runtime-receipt',
          runtimeReceipt.fingerprint,
          runtimeReceipt,
        ),
        findings: [],
        rebuts: [],
      }, cursor);
    }
    cursor += segment.timing.totalMs;
    append('stage-end', {
      stageId: segment.id,
      actualRoute: segment.actualRoute,
      adapter: segment.adapter,
      degradation: segment.degradation,
      telemetry: segment.telemetry,
      providerEvidence: fixtureTypedEvidence(
        runId,
        'provider',
        'provider-accounting',
        segment.id,
        { telemetry: segment.telemetry },
      ),
    }, cursor);
  }
  append('run-finish', {
    terminal: recordValue.unit.outcomes.terminal,
    gate: recordValue.unit.outcomes.gate,
    recovery: {
      resumeKind: recordValue.unit.outcomes.recovery.resumeKind,
      recoveryKind: recordValue.unit.outcomes.recovery.recoveryKind,
    },
    terminalEvidence: fixtureTypedEvidence(
      runId,
      'runtime',
      'terminal-result',
      'run-finish',
      {
        terminal: recordValue.unit.outcomes.terminal,
        sourceFingerprint: recordValue.observation.terminalEvidenceFingerprint,
      },
    ),
    gateEvidence: fixtureTypedEvidence(
      runId,
      'gate',
      'gate-result',
      'run-finish',
      { gate: recordValue.unit.outcomes.gate },
    ),
    lifecycleEvidence: fixtureTypedEvidence(
      runId,
      'lifecycle-contract',
      'lifecycle-result',
      'run-finish',
      {
        recovery: {
          resumeKind: recordValue.unit.outcomes.recovery.resumeKind,
          recoveryKind: recordValue.unit.outcomes.recovery.recoveryKind,
        },
      },
    ),
  }, cursor);
  return trustFixtureEvents(events);
}

function fixtureRecords(count, checkpoint, totalMs = 100) {
  return Array.from({ length: count }, (_, index) => fixtureRecord(totalMs + index, {
    recordId: `123e4567-e89b-42d3-a456-${String(426614174000 + index).padStart(12, '0')}`,
    checkpoint,
    checkpointEndpointFingerprint: createHash('sha256')
      .update(`endpoint-${checkpoint}`)
      .digest('hex'),
    observation: {
      runId: `f23e4567-e89b-42d3-a456-${String(426614174000 + index).padStart(12, '0')}`,
      unitId: `issue-${index + 1}`,
      terminalEvidenceFingerprint: createHash('sha256')
        .update(`terminal-${checkpoint}-${index}`)
        .digest('hex'),
    },
  }));
}

function trustFixtureRecords(records) {
  return records.map((recordValue, index) => {
    const derivation = {
      pipelineVersion: MEASUREMENT_EVENT_VERSION,
      runId: recordValue.observation.runId,
      startRevision: recordValue.revision,
      eventCount: 2,
      eventSetFingerprint: createHash('sha256')
        .update(`fixture-events-${index}-${recordValue.observation.runId}`)
        .digest('hex'),
    };
    const authenticated = {
      ...recordContent(recordValue),
      provenance: {
        kind: 'tool-authenticated',
        storeId: '323e4567-e89b-42d3-a456-426614174000',
        authenticatedAt: '2026-07-24T00:30:00.000Z',
        contentFingerprint: recordContentFingerprint(recordValue),
        observationFingerprint: observationFingerprint(recordValue),
        capture: {
          revisionSource: 'live-git-head',
          timeSource: 'tool-clock',
          checkpointSource: 'operator-declared',
          observationSource: 'derived-authenticated-events',
        },
        derivation,
        mac: createHash('sha256').update(`fixture-${index}`).digest('hex'),
      },
    };
    trustRecord(authenticated);
    markTrustedDerivedRecord(authenticated, derivation);
    return authenticated;
  });
}

function fixtureMatchedControl(subjectOverrides = {}, controlOverrides = {}) {
  const control = trustFixtureRecords([fixtureRecord(120, {
    recordId: 'b23e4567-e89b-42d3-a456-426614174000',
    observation: {
      runId: 'b23e4567-e89b-42d3-a456-426614174001',
      unitId: 'control-1',
      terminalEvidenceFingerprint: 'b'.repeat(64),
    },
    ...controlOverrides,
  })])[0];
  const subject = fixtureRecord(100, {
    recordId: 'c23e4567-e89b-42d3-a456-426614174000',
    observation: {
      runId: 'c23e4567-e89b-42d3-a456-426614174001',
      unitId: 'subject-1',
      terminalEvidenceFingerprint: 'c'.repeat(64),
    },
    ...subjectOverrides,
  });
  const evidence = {
    observedValue: subject.unit.timing.totalMs,
    counterfactualValue: control.unit.timing.totalMs,
    controlRecords: [{
      recordId: control.recordId,
      contentFingerprint: control.provenance.contentFingerprint,
    }],
  };
  subject.unit.outcomes.avoidedRework.avoidedTime = {
    status: 'verified',
    value: evidence.counterfactualValue - evidence.observedValue,
    unit: 'milliseconds',
    method: 'matched-control',
    evidence: {
      ...evidence,
      fingerprint: fingerprint({
        method: 'matched-control',
        unit: 'milliseconds',
        ...evidence,
      }),
    },
  };
  return { subject: trustFixtureRecords([subject])[0], control };
}

function fixtureBudget(sourceResult, maximum = 1_000_000) {
  if (!sourceResult?.ok) {
    throw new Error(`fixture budget source failed: ${sourceResult?.errors?.join('; ') ?? 'unknown error'}`);
  }
  return {
    version: BUDGET_VERSION,
    budgetId: '223e4567-e89b-42d3-a456-426614174000',
    createdAt: '2026-07-24T01:00:00.000Z',
    workload: sourceResult.workload,
    mode: sourceResult.mode,
    source: sourceResult.source,
    floors: { median: 1, p95: 20, stable: 100 },
    limits: Object.fromEntries(BUDGET_METRIC_KEYS.map((key) => [key, maximum])),
  };
}

function concurrentPersist(recordValue, directory) {
  const source = [
    `import { persistMeasurement } from ${JSON.stringify(import.meta.url)};`,
    'const record = JSON.parse(process.argv[1]);',
    'process.exit(persistMeasurement(record, process.argv[2]).ok ? 0 : 1);',
  ].join('');
  const launch = () => new Promise((resolveProcess) => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '--eval', source, JSON.stringify(recordValue), directory],
      { stdio: 'ignore' },
    );
    child.on('error', () => resolveProcess(2));
    child.on('close', (code) => resolveProcess(code));
  });
  return Promise.all([launch(), launch()]);
}

async function concurrentPublishAndRead(recordValue, directory, expectedRecords) {
  const writerSource = [
    `import { persistMeasurement } from ${JSON.stringify(import.meta.url)};`,
    'const record = JSON.parse(process.argv[1]);',
    'process.exit(persistMeasurement(record, process.argv[2]).ok ? 0 : 1);',
  ].join('');
  const readerSource = [
    `import { readMeasurements } from ${JSON.stringify(import.meta.url)};`,
    'const result = readMeasurements(process.argv[1]);',
    `process.exit(result.ok && result.records.length === ${expectedRecords} ? 0 : 1);`,
  ].join('');
  const writer = spawn(
    process.execPath,
    ['--input-type=module', '--eval', writerSource, JSON.stringify(recordValue), directory],
    {
      env: { ...process.env, AUTOLOOP_MEASUREMENT_SELF_TEST: '1' },
      stdio: 'ignore',
    },
  );
  const writerResult = new Promise((resolveProcess) => {
    writer.on('error', () => resolveProcess(2));
    writer.on('close', (code) => resolveProcess(code));
  });
  const deadline = Date.now() + 5_000;
  let observedWindow = false;
  while (Date.now() < deadline) {
    const names = readdirSync(directory);
    if (
      names.some((name) => name === `${recordValue.recordId}.json`)
      && names.some((name) => name.startsWith('.tmp-'))
    ) {
      observedWindow = true;
      break;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  const readerStartedAt = Date.now();
  const reader = spawn(
    process.execPath,
    ['--input-type=module', '--eval', readerSource, directory],
    { stdio: 'ignore' },
  );
  const readerResult = new Promise((resolveProcess) => {
    reader.on('error', () => resolveProcess(2));
    reader.on('close', (code) => resolveProcess(code));
  });
  const [writerStatus, readerStatus] = await Promise.all([writerResult, readerResult]);
  return {
    writerStatus,
    readerStatus,
    observedWindow,
    readerDurationMs: Date.now() - readerStartedAt,
  };
}

// macOS resolves TMPDIR through symlinks (/var -> /private/var) and the store
// legitimately refuses a path that is not its own realpath, so fixtures anchor
// to the resolved root instead of weakening that check.
function selfTestTemporaryRoot() {
  return realpathSync(tmpdir());
}

async function selfTest() {
  const valid = fixtureRecord();
  const missingIntentProvenance = structuredClone(valid);
  delete missingIntentProvenance.intentProvenance;
  const substitutedIntentProvenance = structuredClone(valid);
  substitutedIntentProvenance.intentProvenance = 'verified';
  const unknown = { ...valid, actualRoute: 'retired-top-level-route' };
  const impossible = fixtureRecord(100, {
    activeHost: 'codex',
    selector: 'claude',
    requestedEngine: 'claude',
    requestedRoute: 'claude.native',
  });
  const invalidAdapter = structuredClone(valid);
  invalidAdapter.segments.find((segment) => segment.stage === 'implementation').adapter =
    'claude.native';
  const sameRouteDegradation = structuredClone(valid);
  sameRouteDegradation.segments.find((segment) => segment.id === 'review-2').degradation = {
    code: 'degraded-native-codex-review',
    reason: 'Runtime used its bounded same-route degraded reviewer posture.',
  };
  const unknownNested = structuredClone(valid);
  unknownNested.segments[0].telemetry.retiredTokens = observed(1);
  const invalidLaneRoute = structuredClone(valid);
  invalidLaneRoute.lane = 'docs';
  const sparse = structuredClone(valid);
  sparse.segments = new Array(2);
  sparse.segments[0] = valid.segments[0];
  const missingComparisonContext = structuredClone(valid);
  delete missingComparisonContext.comparisonContextFingerprint;
  const missingCheckpointEndpoint = structuredClone(valid);
  delete missingCheckpointEndpoint.checkpointEndpointFingerprint;
  const hundred = fixtureRecords(100, 'safe-system');
  hundred[99].unit.telemetry.reasoningTokens = unavailable('one unavailable value');
  const summary = summarizeMeasurements(hundred);
  const varyingInvocationRecords = fixtureRecords(100, 'safe-system').map(
    (recordValue, index) => ({
      ...recordValue,
      capabilityFingerprint: createHash('sha256')
        .update(`summary-capability-${index}`)
        .digest('hex'),
      outageFingerprint: createHash('sha256')
        .update(`summary-outage-${index}`)
        .digest('hex'),
    }),
  );
  const varyingInvocationSummary = summarizeMeasurements(varyingInvocationRecords);
  const varyingInvocationSource = buildBudgetSource(
    trustFixtureRecords(varyingInvocationRecords),
  );
  const mixedConfigRecords = structuredClone(varyingInvocationRecords);
  mixedConfigRecords[0].configFingerprint = '4'.repeat(64);
  const mixedConfigSummary = summarizeMeasurements(mixedConfigRecords);
  const mixedConfigSource = buildBudgetSource(
    trustFixtureRecords(mixedConfigRecords),
  );
  const splitEndpointRecords = structuredClone(varyingInvocationRecords);
  splitEndpointRecords[0].checkpointEndpointFingerprint = '4'.repeat(64);
  const splitEndpointSummary = summarizeMeasurements(splitEndpointRecords);
  const totalMetric = summary.unitCohorts[0]?.metrics['unit.timing.totalMs'];
  const reasoningMetric = summary.unitCohorts[0]?.metrics['unit.telemetry.reasoningTokens'];
  const twenty = summarizeMeasurements(fixtureRecords(20, 'safe-system'));
  const legacy = fixtureRecords(20, 'legacy-workflow', 120);
  const safe = fixtureRecords(20, 'safe-system', 100).map((recordValue, index) => ({
    ...recordValue,
    recordId: `323e4567-e89b-42d3-a456-${String(426614174000 + index).padStart(12, '0')}`,
    observation: {
      ...recordValue.observation,
      runId: `a23e4567-e89b-42d3-a456-${String(426614174000 + index).padStart(12, '0')}`,
    },
  }));
  const comparison = compareCheckpoints([...legacy, ...safe]);
  const comparisonContextFingerprint = '8'.repeat(64);
  const comparisonLegacy = legacy.map((recordValue) => ({
    ...recordValue,
    comparisonContextFingerprint,
    checkpointEndpointFingerprint: '5'.repeat(64),
  }));
  const comparisonSafe = safe.map((recordValue, index) => {
    const migrated = structuredClone({
      ...recordValue,
      comparisonContextFingerprint,
      checkpointEndpointFingerprint: '6'.repeat(64),
      configFingerprint: createHash('sha256').update('safe-config').digest('hex'),
      capabilityFingerprint: createHash('sha256')
        .update(`capability-${index}`)
        .digest('hex'),
      outageFingerprint: createHash('sha256').update(`outage-${index}`).digest('hex'),
    });
    const judgment = structuredClone(
      migrated.segments.find(
        (segment) => segment.stage === 'code-review' && segment.round === 2,
      ),
    );
    judgment.id = 'judgment';
    judgment.stage = 'judgment-review';
    judgment.round = 1;
    migrated.segments.splice(
      migrated.segments.findIndex((segment) => segment.stage === 'gate'),
      0,
      judgment,
    );
    migrated.unit.dispatch.count += 1;
    migrated.unit.dispatch.durationMs += judgment.timing.totalMs;
    for (const key of UNIT_TELEMETRY_KEYS) {
      if (migrated.unit.telemetry[key].status === 'observed') {
        migrated.unit.telemetry[key].value += observationValue(judgment.telemetry[key]) ?? 0;
      }
    }
    return migrated;
  });
  const migrationComparison = compareCheckpoints([
    ...comparisonLegacy,
    ...comparisonSafe,
  ]);
  const changedContextComparison = compareCheckpoints([
    ...comparisonLegacy,
    ...comparisonSafe.map((recordValue) => ({
      ...recordValue,
      comparisonContextFingerprint: '9'.repeat(64),
    })),
  ]);
  const changedProviderSafe = structuredClone(comparisonSafe);
  changedProviderSafe.forEach((recordValue) => {
    recordValue.segments[0].telemetry.provider = observed('different-provider');
  });
  const changedProviderComparison = compareCheckpoints([
    ...comparisonLegacy,
    ...changedProviderSafe,
  ]);
  const changedModelSafe = structuredClone(comparisonSafe);
  changedModelSafe.forEach((recordValue) => {
    recordValue.segments[0].telemetry.model = observed('different-model');
  });
  const changedModelComparison = compareCheckpoints([
    ...comparisonLegacy,
    ...changedModelSafe,
  ]);
  const mixedEndpointSafe = structuredClone(comparisonSafe);
  mixedEndpointSafe[0].checkpointEndpointFingerprint = '7'.repeat(64);
  const mixedEndpointComparison = compareCheckpoints([
    ...comparisonLegacy,
    ...mixedEndpointSafe,
  ]);
  const mixedRevisionSafe = structuredClone(comparisonSafe);
  mixedRevisionSafe[0].revision = 'b'.repeat(40);
  const mixedRevisionComparison = compareCheckpoints([
    ...comparisonLegacy,
    ...mixedRevisionSafe,
  ]);
  const mixedConfigSafe = structuredClone(comparisonSafe);
  mixedConfigSafe[0].configFingerprint = '4'.repeat(64);
  const mixedConfigComparison = compareCheckpoints([
    ...comparisonLegacy,
    ...mixedConfigSafe,
  ]);
  const mixedUnmatchedLegacy = structuredClone(comparisonLegacy.slice(0, 2));
  mixedUnmatchedLegacy[1].revision = 'b'.repeat(40);
  mixedUnmatchedLegacy[1].configFingerprint = '4'.repeat(64);
  mixedUnmatchedLegacy[1].checkpointEndpointFingerprint = '7'.repeat(64);
  const mixedUnmatchedComparison = compareCheckpoints(mixedUnmatchedLegacy);
  const unmatchedEvidenceLegacy = structuredClone(comparisonLegacy.slice(0, 2));
  unmatchedEvidenceLegacy[1].capabilityFingerprint = '4'.repeat(64);
  unmatchedEvidenceLegacy[1].outageFingerprint = '5'.repeat(64);
  const unmatchedEvidenceComparison = compareCheckpoints(unmatchedEvidenceLegacy);
  const collisionLegacy = structuredClone(comparisonLegacy);
  const collisionSafe = structuredClone(comparisonSafe);
  for (const [records, degradation] of [
    [collisionLegacy, { code: 'a:b', reason: 'c' }],
    [collisionSafe, { code: 'a', reason: 'b:c' }],
  ]) {
    records.forEach((recordValue) => {
      const implementation = recordValue.segments.find(
        (segment) => segment.stage === 'implementation',
      );
      const native = recordValue.segments.find((segment) => segment.stage === 'premise');
      implementation.actualRoute = native.actualRoute;
      implementation.adapter = native.adapter;
      implementation.degradation = degradation;
      implementation.telemetry.provider = structuredClone(native.telemetry.provider);
      implementation.telemetry.model = structuredClone(native.telemetry.model);
      implementation.telemetry.engine = structuredClone(native.telemetry.engine);
    });
  }
  const changedDegradationComparison = compareCheckpoints([
    ...collisionLegacy,
    ...collisionSafe,
  ]);
  const unavailableIdentityComparisons = ['provider', 'model', 'engine'].map((identity) => {
    const unavailableLegacy = structuredClone(legacy);
    const unavailableSafe = structuredClone(safe);
    for (const records of [unavailableLegacy, unavailableSafe]) {
      records.forEach((recordValue) => {
        recordValue.segments[0].telemetry[identity] =
          unavailable('provider omitted comparison identity');
      });
    }
    return compareCheckpoints([...unavailableLegacy, ...unavailableSafe]);
  });
  const evidencedUnitTotal = structuredClone(valid);
  evidencedUnitTotal.segments.forEach((segment) => {
    segment.telemetry.provider = observed('openai');
  });
  const rawUnitTotalEvidence = {
    version: 1,
    runId: evidencedUnitTotal.observation.runId,
    unitId: evidencedUnitTotal.observation.unitId,
    metric: 'reasoningTokens',
    provider: 'openai',
    value: 42,
  };
  evidencedUnitTotal.unit.telemetry.reasoningTokens = {
    status: 'observed',
    value: 42,
    provenance: {
      method: 'provider-unit-total',
      evidenceFingerprint: fingerprint(rawUnitTotalEvidence),
      rawEvidence: rawUnitTotalEvidence,
    },
  };
  const unprovenUnitTotal = structuredClone(evidencedUnitTotal);
  unprovenUnitTotal.unit.telemetry.reasoningTokens = observed(42);
  const mismatchedUnitTotalEvidence = structuredClone(evidencedUnitTotal);
  mismatchedUnitTotalEvidence.unit.telemetry.reasoningTokens.provenance.evidenceFingerprint =
    '0'.repeat(64);
  const missingRawUnitTotalEvidence = structuredClone(evidencedUnitTotal);
  delete missingRawUnitTotalEvidence.unit.telemetry.reasoningTokens.provenance.rawEvidence;
  const mismatchedProviderUnitEvidence = [
    ['runId', 'e23e4567-e89b-42d3-a456-426614174001'],
    ['unitId', 'different-unit'],
    ['metric', 'outputTokens'],
    ['provider', 'different-provider'],
    ['value', 43],
  ].map(([key, replacement]) => {
    const recordValue = structuredClone(evidencedUnitTotal);
    const provenance = recordValue.unit.telemetry.reasoningTokens.provenance;
    provenance.rawEvidence[key] = replacement;
    provenance.evidenceFingerprint = fingerprint(provenance.rawEvidence);
    return recordValue;
  });
  const arbitraryProviderUnitEvidence = structuredClone(evidencedUnitTotal);
  arbitraryProviderUnitEvidence.unit.telemetry.reasoningTokens.provenance.rawEvidence = {
    arbitrary: 'provider response',
  };
  arbitraryProviderUnitEvidence.unit.telemetry.reasoningTokens.provenance.evidenceFingerprint =
    fingerprint(
      arbitraryProviderUnitEvidence.unit.telemetry.reasoningTokens.provenance.rawEvidence,
    );
  const mismatchedObservedSegmentSum = structuredClone(valid);
  mismatchedObservedSegmentSum.unit.telemetry.promptTokens.value += 1;
  const baseline = trustFixtureRecords(fixtureRecords(100, 'safe-system'));
  const source = buildBudgetSource(baseline);
  const budget = fixtureBudget(source);
  const current = trustFixtureRecords(fixtureRecords(100, 'post-optimization', 80).map((recordValue, index) => ({
    ...recordValue,
    recordId: `423e4567-e89b-42d3-a456-${String(426614174000 + index).padStart(12, '0')}`,
    observation: {
      ...recordValue.observation,
      runId: `423e4567-e89b-42d3-a456-${String(426614174000 + index).padStart(12, '0')}`,
    },
  })));
  const pendingBudgetPolicy = {
    version: BUDGET_POLICY_VERSION,
    status: 'pending-evidence',
    reason: 'No authenticated safe-system and current cohorts have been retained.',
    evidenceBundle: null,
    budgets: [],
  };
  const pendingPolicyEvaluation = evaluateBudgetPolicy(pendingBudgetPolicy, []);
  const rawEvents = fixtureAuthenticatedEvents(valid);
  const legacyEventStreamRecord = structuredClone(valid);
  legacyEventStreamRecord.checkpoint = 'legacy-workflow';
  const legacyEventStreamDerivation = deriveMeasurementFromEvents(
    fixtureAuthenticatedEvents(legacyEventStreamRecord),
    'd23e4567-e89b-42d3-a456-426614174022',
  );
  const omittedRunStartProvenanceEvents = structuredClone(rawEvents);
  delete omittedRunStartProvenanceEvents[0].payload.intentProvenance;
  trustFixtureEvents(omittedRunStartProvenanceEvents);
  const omittedRunStartProvenanceDerivation = deriveMeasurementFromEvents(
    omittedRunStartProvenanceEvents,
    'd23e4567-e89b-42d3-a456-426614174020',
  );
  const substitutedReceiptProvenanceEvents = structuredClone(rawEvents);
  const substitutedDispatch = substitutedReceiptProvenanceEvents.find(
    (eventValue) => eventValue.kind === 'dispatch',
  );
  const substitutedReceipt =
    substitutedDispatch.payload.runtimeReceipt.envelope.payload;
  substitutedReceipt.intentProvenance = 'verified';
  delete substitutedReceipt.fingerprint;
  substitutedReceipt.fingerprint = fingerprint(substitutedReceipt);
  substitutedDispatch.payload.dispatchId = substitutedReceipt.fingerprint;
  substitutedDispatch.payload.runtimeReceipt.envelope.subjectId =
    substitutedReceipt.fingerprint;
  substitutedDispatch.payload.runtimeReceipt.envelope.payloadFingerprint =
    fingerprint(substitutedReceipt);
  substitutedDispatch.payload.runtimeReceipt.fingerprint = fingerprint(
    substitutedDispatch.payload.runtimeReceipt.envelope,
  );
  trustFixtureEvents(substitutedReceiptProvenanceEvents);
  const substitutedReceiptProvenanceDerivation = deriveMeasurementFromEvents(
    substitutedReceiptProvenanceEvents,
    'd23e4567-e89b-42d3-a456-426614174021',
  );
  const retryRuntime = fixtureRetryReceiptForMeasurement();
  const retryCaptureStore = join(
    selfTestTemporaryRoot(),
    `autoloop-measurement-retry-${randomUUID()}`,
  );
  const retryRunId = randomUUID();
  const retryDeclaration = {
    version: 1,
    runId: retryRunId,
    workload: 'retry-capture-fixture',
    checkpoint: 'safe-system',
    comparisonContextFingerprint: '7'.repeat(64),
    checkpointEndpointFingerprint: '8'.repeat(64),
    intentSource: 'invocation',
    intentProvenance: INTENT_PROVENANCE,
    mergePolicy: 'manual',
    baseFreshnessStrategy: 'direct-strict',
  };
  const omittedRetryDeclaration = structuredClone(retryDeclaration);
  delete omittedRetryDeclaration.intentProvenance;
  const substitutedRetryDeclaration = structuredClone(retryDeclaration);
  substitutedRetryDeclaration.intentProvenance = 'verified';
  const retryBinding = {
    run: retryRuntime.run,
    measurement: retryDeclaration,
  };
  const omittedRetryBinding = {
    ...retryBinding,
    measurement: omittedRetryDeclaration,
  };
  const substitutedRetryBinding = {
    ...retryBinding,
    measurement: substitutedRetryDeclaration,
  };
  const lateRetryBinding = {
    ...retryBinding,
    capabilities: retryRuntime.capabilities,
    routeState: retryRuntime.initialRouteState,
  };
  const retryStartCapture = captureProducerMeasurementEvent(
    runtimeStartCaptureInput({
      measurement: retryDeclaration,
      run: retryRuntime.run,
    }),
    retryCaptureStore,
    'runtime-authority-verified',
  );
  const retryUnitCapture = captureProducerMeasurementEvent(
    runtimeUnitContextCaptureInput({
      runId: retryRunId,
      run: retryRuntime.run,
      plan: retryRuntime.initialPlan,
      unitId: 'retry-capture-fixture',
    }),
    retryCaptureStore,
    'runtime-authority-verified',
  );
  const retryStageCapture = captureProducerMeasurementEvent({
    version: 1,
    runId: retryRunId,
    kind: 'stage-start',
    payload: {
      id: 'retry-capture-stage',
      stage: retryRuntime.receipt.stage,
      round: retryRuntime.receipt.round,
    },
    envelopes: {},
  }, retryCaptureStore, 'runtime-authority-verified');
  const retryDispatchCapture = captureRuntimeDispatchMeasurementAt({
    runId: retryRunId,
    receipt: retryRuntime.receipt,
  }, retryCaptureStore);
  const retryCapturedEvents = readMeasurementEvents(
    retryCaptureStore,
    retryRunId,
  );
  const publicUnitContextCapture = buildTypedMeasurementEvent({
    version: MEASUREMENT_EVENT_VERSION,
    runId: valid.observation.runId,
    kind: 'unit-context',
    payload: structuredClone(
      rawEvents.find((eventValue) => eventValue.kind === 'unit-context').payload,
    ),
    envelopes: {},
  });
  const gapEvents = fixtureAuthenticatedEvents(valid, {
    preSelectionGapMs: 37,
  });
  const gapDerivation = deriveMeasurementFromEvents(
    gapEvents,
    'd23e4567-e89b-42d3-a456-426614174011',
  );
  const missingSelectionEvents = structuredClone(rawEvents).filter(
    (eventValue) =>
      eventValue.payload?.stage !== 'selection'
      && eventValue.payload?.stageId !== 'selection',
  );
  trustFixtureEvents(missingSelectionEvents);
  const missingSelectionDerivation = deriveMeasurementFromEvents(
    missingSelectionEvents,
    'd23e4567-e89b-42d3-a456-426614174012',
  );
  const duplicateSelectionEvents = structuredClone(rawEvents);
  const selectionStartIndex = duplicateSelectionEvents.findIndex(
    (eventValue) =>
      eventValue.kind === 'stage-start'
      && eventValue.payload.stage === 'selection',
  );
  const duplicateStart = structuredClone(
    duplicateSelectionEvents[selectionStartIndex],
  );
  duplicateStart.payload.id = 'selection-duplicate';
  const duplicateEnd = structuredClone(
    duplicateSelectionEvents.find((eventValue) =>
      eventValue.kind === 'stage-end'
      && eventValue.payload.stageId === 'selection'),
  );
  duplicateEnd.payload.stageId = duplicateStart.payload.id;
  duplicateSelectionEvents.splice(
    selectionStartIndex + 2,
    0,
    duplicateStart,
    duplicateEnd,
  );
  trustFixtureEvents(duplicateSelectionEvents);
  const duplicateSelectionDerivation = deriveMeasurementFromEvents(
    duplicateSelectionEvents,
    'd23e4567-e89b-42d3-a456-426614174013',
  );
  const promotedRecord = fixtureRecord();
  promotedRecord.lane = 'small';
  const promotedProof = '9'.repeat(64);
  for (const segment of promotedRecord.segments) {
    segment.effectiveLane = 'small';
    segment.laneProofFingerprint = promotedProof;
  }
  const planReview = promotedRecord.segments.find((segment) =>
    segment.stage === 'plan-review');
  planReview.requestedRoute = 'claude.native';
  planReview.actualRoute = 'claude.native';
  planReview.adapter = 'claude.native';
  for (const segment of promotedRecord.segments.filter((candidate) =>
    candidate.stage === 'code-review')) {
    segment.effectiveLane = 'full';
    segment.laneProofFingerprint = 'a'.repeat(64);
  }
  const promotedDerivation = deriveMeasurementFromEvents(
    fixtureAuthenticatedEvents(promotedRecord),
    'd23e4567-e89b-42d3-a456-426614174014',
  );
  const outageEvents = structuredClone(rawEvents);
  const outageProfile = ['probe', 'entered', 'entered', 'continued'];
  outageEvents.filter((eventValue) =>
    eventValue.kind === 'dispatch').forEach((eventValue, index) => {
    const evidence = eventValue.payload.runtimeReceipt;
    const receiptValue = evidence.envelope.payload;
    receiptValue.outageTransition = outageProfile[index];
    delete receiptValue.fingerprint;
    receiptValue.fingerprint = fingerprint(receiptValue);
    eventValue.payload.dispatchId = receiptValue.fingerprint;
    evidence.envelope.subjectId = receiptValue.fingerprint;
    evidence.envelope.payloadFingerprint = fingerprint(receiptValue);
    evidence.fingerprint = fingerprint(evidence.envelope);
  });
  trustFixtureEvents(outageEvents);
  const outageDerivation = deriveMeasurementFromEvents(
    outageEvents,
    'd23e4567-e89b-42d3-a456-426614174015',
  );
  const typedOperationInput = {
    version: MEASUREMENT_EVENT_VERSION,
    runId: valid.observation.runId,
    kind: 'operation',
    payload: {
      stageId: 'premise',
      operationId: 'typed-operation',
      kind: 'subprocess',
      action: 'run exact typed command wrapper',
    },
    envelopes: {
      evidence: {
        producer: 'command-wrapper',
        type: 'subprocess-result',
        subjectId: 'typed-operation',
        payload: fixtureCommandResult(),
      },
    },
  };
  const callerObservedOperationCapture = buildTypedMeasurementEvent(
    typedOperationInput,
  );
  const typedOperationCapture = buildProducerMeasurementEvent(
    typedOperationInput,
  );
  const tamperedTypedOperation = structuredClone(typedOperationCapture.event);
  tamperedTypedOperation.payload.evidence.envelope.payload.exitCode = 1;
  const derivedFromEvents = deriveMeasurementFromEvents(
    rawEvents,
    'd23e4567-e89b-42d3-a456-426614174000',
  );
  const replayedOperationEvents = structuredClone(rawEvents);
  const operationIndex = replayedOperationEvents.findIndex(
    (eventValue) => eventValue.kind === 'operation',
  );
  replayedOperationEvents.splice(
    operationIndex + 1,
    0,
    structuredClone(replayedOperationEvents[operationIndex]),
  );
  trustFixtureEvents(replayedOperationEvents);
  const replayedOperationDerivation = deriveMeasurementFromEvents(
    replayedOperationEvents,
    'd23e4567-e89b-42d3-a456-426614174001',
  );
  const reorderedEvents = structuredClone(rawEvents);
  const stageEndIndex = reorderedEvents.findIndex(
    (eventValue) => eventValue.kind === 'stage-end',
  );
  [reorderedEvents[stageEndIndex], reorderedEvents[stageEndIndex + 1]] =
    [reorderedEvents[stageEndIndex + 1], reorderedEvents[stageEndIndex]];
  trustFixtureEvents(reorderedEvents);
  const reorderedDerivation = deriveMeasurementFromEvents(
    reorderedEvents,
    'd23e4567-e89b-42d3-a456-426614174002',
  );
  const mixedRunEvents = structuredClone(rawEvents);
  mixedRunEvents[2].runId = 'd23e4567-e89b-42d3-a456-426614174003';
  trustFixtureEvents(mixedRunEvents);
  const mixedRunDerivation = deriveMeasurementFromEvents(
    mixedRunEvents,
    'd23e4567-e89b-42d3-a456-426614174004',
  );
  const revisionTransitionEvents = structuredClone(rawEvents);
  revisionTransitionEvents.slice(2).forEach((eventValue) => {
    eventValue.revision = 'b'.repeat(40);
  });
  trustFixtureEvents(revisionTransitionEvents);
  const revisionTransitionDerivation = deriveMeasurementFromEvents(
    revisionTransitionEvents,
    'd23e4567-e89b-42d3-a456-426614174010',
  );
  const revisionTransitionRecord = revisionTransitionDerivation.ok
    ? {
        ...revisionTransitionDerivation.record,
        provenance: {
          kind: 'tool-authenticated',
          storeId: '323e4567-e89b-42d3-a456-426614174000',
          authenticatedAt: '2026-07-24T00:30:00.000Z',
          contentFingerprint: recordContentFingerprint(
            revisionTransitionDerivation.record,
          ),
          observationFingerprint: observationFingerprint(
            revisionTransitionDerivation.record,
          ),
          capture: {
            revisionSource: 'live-git-head',
            timeSource: 'tool-clock',
            checkpointSource: 'operator-declared',
            observationSource: 'derived-authenticated-events',
          },
          derivation: revisionTransitionDerivation.derivation,
          mac: '9'.repeat(64),
        },
      }
    : null;
  const revisionTransitionBundle = validateMeasurementEvidenceBundle({
    version: MEASUREMENT_EVIDENCE_BUNDLE_VERSION,
    kind: 'autoloop-measurement-evidence',
    createdAt: '2026-07-24T00:31:00.000Z',
    records: [{
      record: revisionTransitionRecord,
      events: revisionTransitionEvents,
    }],
  });
  const misboundTransitionResultRecord = structuredClone(revisionTransitionRecord);
  if (misboundTransitionResultRecord !== null) {
    misboundTransitionResultRecord.revision = revisionTransitionEvents[0].revision;
    misboundTransitionResultRecord.provenance.contentFingerprint =
      recordContentFingerprint(misboundTransitionResultRecord);
    misboundTransitionResultRecord.provenance.observationFingerprint =
      observationFingerprint(misboundTransitionResultRecord);
  }
  const misboundTransitionResultBundle = validateMeasurementEvidenceBundle({
    version: MEASUREMENT_EVIDENCE_BUNDLE_VERSION,
    kind: 'autoloop-measurement-evidence',
    createdAt: '2026-07-24T00:31:00.000Z',
    records: [{
      record: misboundTransitionResultRecord,
      events: revisionTransitionEvents,
    }],
  });
  const misboundTransitionStartRecord = structuredClone(revisionTransitionRecord);
  if (misboundTransitionStartRecord !== null) {
    misboundTransitionStartRecord.provenance.derivation.startRevision =
      revisionTransitionEvents.at(-1).revision;
  }
  const misboundTransitionStartBundle = validateMeasurementEvidenceBundle({
    version: MEASUREMENT_EVIDENCE_BUNDLE_VERSION,
    kind: 'autoloop-measurement-evidence',
    createdAt: '2026-07-24T00:31:00.000Z',
    records: [{
      record: misboundTransitionStartRecord,
      events: revisionTransitionEvents,
    }],
  });
  const unavailableOperationEvents = structuredClone(rawEvents);
  unavailableOperationEvents.find(
    (eventValue) => eventValue.kind === 'operation',
  ).payload.evidence = {
    status: 'unavailable',
    reason: 'command wrapper did not return an evidence envelope',
  };
  trustFixtureEvents(unavailableOperationEvents);
  const unavailableOperationDerivation = deriveMeasurementFromEvents(
    unavailableOperationEvents,
    'd23e4567-e89b-42d3-a456-426614174005',
  );
  const unavailableReceiptEvents = structuredClone(rawEvents);
  unavailableReceiptEvents.find(
    (eventValue) =>
      eventValue.kind === 'dispatch'
      && eventValue.payload.stageId === 'plan',
  ).payload.runtimeReceipt = {
    status: 'unavailable',
    reason: 'Runtime receipt was not returned',
  };
  trustFixtureEvents(unavailableReceiptEvents);
  const unavailableReceiptDerivation = deriveMeasurementFromEvents(
    unavailableReceiptEvents,
    'd23e4567-e89b-42d3-a456-426614174006',
  );
  const mismatchedRouteEvents = structuredClone(rawEvents);
  const mismatchedRouteDispatch = mismatchedRouteEvents.find(
    (eventValue) =>
      eventValue.kind === 'dispatch'
      && eventValue.payload.stageId === 'plan',
  );
  const mismatchedRuntimeEnvelope =
    mismatchedRouteDispatch.payload.runtimeReceipt.envelope;
  const mismatchedRuntimeReceipt = mismatchedRuntimeEnvelope.payload;
  delete mismatchedRuntimeReceipt.fingerprint;
  mismatchedRuntimeReceipt.actualRoute = 'claude.native';
  mismatchedRuntimeReceipt.adapter = 'claude.native';
  mismatchedRuntimeReceipt.fingerprint = fingerprint(mismatchedRuntimeReceipt);
  mismatchedRouteDispatch.payload.dispatchId =
    mismatchedRuntimeReceipt.fingerprint;
  mismatchedRuntimeEnvelope.subjectId = mismatchedRuntimeReceipt.fingerprint;
  mismatchedRuntimeEnvelope.payloadFingerprint =
    fingerprint(mismatchedRuntimeReceipt);
  mismatchedRouteDispatch.payload.runtimeReceipt.fingerprint =
    fingerprint(mismatchedRuntimeEnvelope);
  trustFixtureEvents(mismatchedRouteEvents);
  const mismatchedRouteDerivation = deriveMeasurementFromEvents(
    mismatchedRouteEvents,
    'd23e4567-e89b-42d3-a456-426614174009',
  );
  const unavailableProviderEvents = structuredClone(rawEvents);
  const unavailableProviderStage = unavailableProviderEvents.find(
    (eventValue) => eventValue.kind === 'stage-end',
  );
  unavailableProviderStage.payload.telemetry.provider =
    unavailable('provider envelope omitted identity');
  unavailableProviderStage.payload.providerEvidence.envelope.payload.telemetry =
    structuredClone(unavailableProviderStage.payload.telemetry);
  unavailableProviderStage.payload.providerEvidence.envelope.payloadFingerprint =
    fingerprint(unavailableProviderStage.payload.providerEvidence.envelope.payload);
  unavailableProviderStage.payload.providerEvidence.fingerprint =
    fingerprint(unavailableProviderStage.payload.providerEvidence.envelope);
  trustFixtureEvents(unavailableProviderEvents);
  const unavailableProviderDerivation = deriveMeasurementFromEvents(
    unavailableProviderEvents,
    'd23e4567-e89b-42d3-a456-426614174007',
  );
  const tamperedEvents = structuredClone(rawEvents);
  tamperedEvents[2].payload.action = 'inflated caller operation';
  TRUSTED_EVENTS.add(tamperedEvents[2]);
  for (const [index, eventValue] of tamperedEvents.entries()) {
    if (index !== 2) TRUSTED_EVENTS.add(eventValue);
  }
  const tamperedDerivation = deriveMeasurementFromEvents(
    tamperedEvents,
    'd23e4567-e89b-42d3-a456-426614174008',
  );
  const activeBudgetPolicy = {
    version: BUDGET_POLICY_VERSION,
    status: 'active',
    reason: null,
    evidenceBundle: {
      path: MEASUREMENT_EVIDENCE_BUNDLE_PATH,
      sha256: 'a'.repeat(64),
    },
    budgets: [{
      budget,
      baselineRecordIds: budget.source.records.map((record) => record.recordId),
      currentRecordIds: current.map((record) => record.recordId).sort(),
    }],
  };
  const activePolicyEvaluation = evaluateBudgetPolicy(
    activeBudgetPolicy,
    [...baseline, ...current],
  );
  const missingPolicyRecordEvaluation = evaluateBudgetPolicy(
    activeBudgetPolicy,
    [...baseline, ...current.slice(0, -1)],
  );
  const provisionalBudgetPolicy = structuredClone(activeBudgetPolicy);
  provisionalBudgetPolicy.budgets[0].currentRecordIds =
    current.slice(0, 20).map((record) => record.recordId).sort();
  const provisionalPolicyEvaluation = evaluateBudgetPolicy(
    provisionalBudgetPolicy,
    [...baseline, ...current.slice(0, 20)],
  );
  const regressedBudgetPolicy = structuredClone(activeBudgetPolicy);
  regressedBudgetPolicy.budgets[0].budget.limits.unitTimeP50Ms = 1;
  const regressedPolicyEvaluation = evaluateBudgetPolicy(
    regressedBudgetPolicy,
    [...baseline, ...current],
  );
  const duplicatePolicyCohort = structuredClone(activeBudgetPolicy);
  duplicatePolicyCohort.budgets[0].currentRecordIds[0] =
    duplicatePolicyCohort.budgets[0].baselineRecordIds[0];
  duplicatePolicyCohort.budgets[0].currentRecordIds.sort();
  const canonicalPendingPolicy = canonicalBudgetPolicy(pendingBudgetPolicy);
  const duplicateKeyPolicy = parseBudgetPolicy(
    '{"budgets":[],"evidenceBundle":null,"reason":"No evidence.","status":"pending-evidence","version":1,"version":1}\n',
  );
  const secondBaseline = trustFixtureRecords(
    fixtureRecords(100, 'safe-system').map((recordValue, index) => ({
      ...recordValue,
      recordId:
        `623e4567-e89b-42d3-a456-${String(426614174000 + index).padStart(12, '0')}`,
      workload: 'fixture-ratified',
      mergePolicy: 'ratified',
      observation: {
        ...recordValue.observation,
        runId:
          `623e4567-e89b-42d3-a456-${String(426614175000 + index).padStart(12, '0')}`,
        unitId: `ratified-safe-${index}`,
        terminalEvidenceFingerprint: createHash('sha256')
          .update(`ratified-safe-terminal-${index}`)
          .digest('hex'),
      },
    })),
  );
  const secondSource = buildBudgetSource(secondBaseline);
  const secondBudget = fixtureBudget(secondSource);
  secondBudget.budgetId = '723e4567-e89b-42d3-a456-426614174000';
  const secondCurrent = trustFixtureRecords(
    fixtureRecords(100, 'post-optimization', 80).map((recordValue, index) => ({
      ...recordValue,
      recordId:
        `723e4567-e89b-42d3-a456-${String(426614175000 + index).padStart(12, '0')}`,
      workload: 'fixture-ratified',
      mergePolicy: 'ratified',
      observation: {
        ...recordValue.observation,
        runId:
          `823e4567-e89b-42d3-a456-${String(426614175000 + index).padStart(12, '0')}`,
        unitId: `ratified-current-${index}`,
        terminalEvidenceFingerprint: createHash('sha256')
          .update(`ratified-current-terminal-${index}`)
          .digest('hex'),
      },
    })),
  );
  const routedBudgetPolicy = structuredClone(activeBudgetPolicy);
  routedBudgetPolicy.budgets.push({
    budget: secondBudget,
    baselineRecordIds: secondBudget.source.records.map((record) => record.recordId),
    currentRecordIds: secondCurrent.map((record) => record.recordId).sort(),
  });
  routedBudgetPolicy.budgets.sort((left, right) =>
    budgetPolicyRouteKey(left).localeCompare(budgetPolicyRouteKey(right)));
  const routedPolicyEvaluation = evaluateBudgetPolicy(
    routedBudgetPolicy,
    [...baseline, ...current, ...secondBaseline, ...secondCurrent],
  );
  const withUnavailableRuntimeIdentity = (records) => records.map((recordValue) => {
    const unavailableRecord = structuredClone(recordValue);
    unavailableRecord.segments.forEach((segment) => {
      for (const identity of ['provider', 'model', 'engine']) {
        segment.telemetry[identity] = unavailable('identity not exposed');
      }
    });
    return unavailableRecord;
  });
  const unavailableBaseline = trustFixtureRecords(
    withUnavailableRuntimeIdentity(fixtureRecords(100, 'safe-system')),
  );
  const unavailableSource = buildBudgetSource(unavailableBaseline);
  const retainedUnavailableSource = (() => {
    const first = unavailableBaseline[0];
    const mode = recordMode(first);
    const records = unavailableBaseline.map((recordValue) => ({
      recordId: recordValue.recordId,
      contentFingerprint: recordValue.provenance.contentFingerprint,
      provenanceMac: recordValue.provenance.mac,
    })).sort((left, right) => left.recordId.localeCompare(right.recordId));
    const evidence = Object.fromEntries(
      Object.entries(BUDGET_METRICS).map(([name, definition]) => [
        name,
        budgetMetricEvidence(unavailableBaseline, definition),
      ]),
    );
    const retainedSource = {
      checkpoint: 'safe-system',
      revision: first.revision,
      cohortFingerprint: '',
      records,
      evidence,
    };
    retainedSource.cohortFingerprint = sourceFingerprint(
      retainedSource,
      first.workload,
      mode,
    );
    return {
      ok: true,
      workload: first.workload,
      mode,
      source: retainedSource,
    };
  })();
  const unavailableCurrent = trustFixtureRecords(withUnavailableRuntimeIdentity(
    fixtureRecords(100, 'post-optimization', 80).map((recordValue, index) => ({
      ...recordValue,
      recordId: `623e4567-e89b-42d3-a456-${String(426614174000 + index).padStart(12, '0')}`,
      observation: {
        ...recordValue.observation,
        runId: `623e4567-e89b-42d3-a456-${String(426614174000 + index).padStart(12, '0')}`,
      },
    })),
  ));
  const unavailableBudget = evaluateBudget(
    fixtureBudget(retainedUnavailableSource),
    unavailableBaseline,
    unavailableCurrent,
  );
  const passedBudget = evaluateBudget(budget, baseline, current);
  const reversedBaselineBudget = evaluateBudget(budget, [...baseline].reverse(), current);
  const decoyBaseline = trustFixtureRecords([fixtureRecord(77, {
    recordId: 'aa3e4567-e89b-42d3-a456-426614174000',
    configFingerprint: '9'.repeat(64),
    observation: {
      runId: 'aa3e4567-e89b-42d3-a456-426614174001',
      unitId: 'decoy',
      terminalEvidenceFingerprint: '9'.repeat(64),
    },
  })])[0];
  const decoyBaselineBudget = evaluateBudget(
    budget,
    [decoyBaseline, ...baseline],
    current,
  );
  const revisedCurrent = trustFixtureRecords(current.map((recordValue) => ({
    ...recordContent(recordValue),
    revision: 'b'.repeat(40),
  })));
  const revisedCurrentBudget = evaluateBudget(budget, baseline, revisedCurrent);
  const mixedRevisionCurrent = trustFixtureRecords(
    revisedCurrent.map((recordValue, index) => ({
      ...recordContent(recordValue),
      revision: index === 0 ? 'c'.repeat(40) : recordValue.revision,
    })),
  );
  const mixedRevisionCurrentBudget = evaluateBudget(
    budget,
    baseline,
    mixedRevisionCurrent,
  );
  const failedBudget = evaluateBudget(
    { ...budget, limits: { ...budget.limits, unitTimeP95Ms: 100 } },
    baseline,
    current,
  );
  const duplicateCurrentBudget = evaluateBudget(budget, baseline, [current[0], current[0]]);
  const reusedObservationCurrent = trustFixtureRecords(current.map((recordValue, index) => ({
    ...recordContent(recordValue),
    observation: structuredClone(baseline[index].observation),
  })));
  const reusedObservationBudget = evaluateBudget(
    budget,
    baseline,
    reusedObservationCurrent,
  );
  const reusedTerminalCurrent = trustFixtureRecords(current.map((recordValue, index) => ({
    ...recordContent(recordValue),
    observation: {
      ...recordValue.observation,
      terminalEvidenceFingerprint:
        baseline[index].observation.terminalEvidenceFingerprint,
    },
  })));
  const reusedTerminalBudget = evaluateBudget(budget, baseline, reusedTerminalCurrent);
  const shortBaseline = trustFixtureRecords(fixtureRecords(20, 'safe-system'));
  const shortSource = buildBudgetSource(shortBaseline);
  const provisionalBudget = evaluateBudget(
    fixtureBudget(shortSource),
    shortBaseline,
    trustFixtureRecords(fixtureRecords(20, 'post-optimization').map((recordValue, index) => ({
      ...recordValue,
      recordId: `523e4567-e89b-42d3-a456-${String(426614174000 + index).padStart(12, '0')}`,
      observation: {
        ...recordValue.observation,
        runId: `523e4567-e89b-42d3-a456-${String(426614174000 + index).padStart(12, '0')}`,
      },
    }))),
  );
  const tinyBaseline = trustFixtureRecords(fixtureRecords(19, 'safe-system'));
  const tinySource = buildBudgetSource(tinyBaseline);
  const refusedBudget = evaluateBudget(
    fixtureBudget(tinySource),
    tinyBaseline,
    trustFixtureRecords(fixtureRecords(19, 'post-optimization').map((recordValue, index) => ({
      ...recordValue,
      recordId: `623e4567-e89b-42d3-a456-${String(426614174000 + index).padStart(12, '0')}`,
      observation: {
        ...recordValue.observation,
        runId: `623e4567-e89b-42d3-a456-${String(426614174000 + index).padStart(12, '0')}`,
      },
    }))),
  );
  const claim = structuredClone(valid);
  claim.unit.outcomes.laneEffectiveness.avoidedEngineTime = {
    status: 'verified',
    value: 100,
    unit: 'milliseconds',
    method: 'matched-control',
    evidence: {
      fingerprint: 'e'.repeat(64),
      observedValue: 10,
      counterfactualValue: 110,
      controlRecords: [],
    },
  };
  const eventStore = join(selfTestTemporaryRoot(), `autoloop-measurement-events-${randomUUID()}`);
  const retainedRunId = 'e23e4567-e89b-42d3-a456-426614174000';
  const retainedEventInputs = [
    rawEvents[0],
    rawEvents.find((eventValue) =>
      eventValue.kind === 'stage-start' && eventValue.payload.stage === 'premise'),
    rawEvents.find((eventValue) =>
      eventValue.kind === 'stage-end' && eventValue.payload.stageId === 'premise'),
    rawEvents.find((eventValue) =>
      eventValue.kind === 'stage-start' && eventValue.payload.stage === 'selection'),
    rawEvents.find((eventValue) =>
      eventValue.kind === 'stage-end' && eventValue.payload.stageId === 'selection'),
    rawEvents.find((eventValue) => eventValue.kind === 'unit-context'),
    {
      ...rawEvents.at(-1),
      payload: {
        ...rawEvents.at(-1).payload,
        terminal: {
          status: 'blocked',
          stage: 'selection',
          reason: 'fixture stops after selection',
        },
        gate: { result: 'not-run', localGreenCiRed: false },
        gateEvidence: {
          status: 'unavailable',
          reason: 'gate did not run',
        },
      },
    },
  ].map((eventValue) => {
    const payload = structuredClone(eventValue.payload);
    if (eventValue.kind === 'run-finish') {
      payload.terminalEvidence.envelope.payload.terminal =
        structuredClone(payload.terminal);
      payload.terminalEvidence.envelope.payloadFingerprint =
        fingerprint(payload.terminalEvidence.envelope.payload);
    }
    for (const value of Object.values(payload)) {
      if (value?.status !== 'observed' || !plainObject(value.envelope)) continue;
      value.envelope.runId = retainedRunId;
      value.fingerprint = fingerprint(value.envelope);
    }
    return {
      version: MEASUREMENT_EVENT_VERSION,
      runId: retainedRunId,
      kind: eventValue.kind,
      payload,
    };
  });
  const retainedEventWrites = retainedEventInputs.map((input) =>
    persistMeasurementEvent(input, eventStore));
  if (retainedEventWrites.some((result) => !result.ok)) {
    throw new Error(
      `fixture event write failed: ${retainedEventWrites
        .flatMap((result) => result.errors ?? [])
        .join('; ')}`,
    );
  }
  const retainedFinalization = finalizeMeasurementRun({
    runId: retainedRunId,
    recordId: 'e23e4567-e89b-42d3-a456-426614174001',
  }, eventStore);
  if (!retainedFinalization.ok) {
    throw new Error(
      `fixture event finalization failed: ${retainedFinalization.errors.join('; ')}`,
    );
  }
  const operationStore = join(
    selfTestTemporaryRoot(),
    `autoloop-measurement-operation-${randomUUID()}`,
  );
  const operationRunId = 'a23e4567-e89b-42d3-a456-426614174000';
  const operationSeedInputs = retainedEventInputs.slice(0, 2).map((input) => {
    const rebound = { ...structuredClone(input), runId: operationRunId };
    const runtimeBinding = rebound.payload.runtimeBinding;
    if (runtimeBinding?.status === 'observed') {
      runtimeBinding.envelope.runId = operationRunId;
      runtimeBinding.fingerprint = fingerprint(runtimeBinding.envelope);
    }
    return rebound;
  });
  const operationSeedWrites = operationSeedInputs.map((input) =>
    persistMeasurementEvent(input, operationStore, 'run-boundary-declared'));
  const measuredOperationInput = {
    version: 1,
    runId: operationRunId,
    stageId: 'premise',
    operationId: 'measured-node-version',
    kind: 'subprocess',
    action: 'read the Node.js version',
    command: {
      executable: process.execPath,
      args: ['--version'],
      cwd: GIT_CONTEXT,
    },
  };
  const measuredOperation = runMeasuredOperation(
    measuredOperationInput,
    operationStore,
  );
  let duplicateOperationExecuted = false;
  const duplicateMeasuredOperation = runMeasuredOperation(
    measuredOperationInput,
    operationStore,
    () => {
      duplicateOperationExecuted = true;
      return {};
    },
  );
  const measuredOperationRead = readMeasurementEvents(
    operationStore,
    operationRunId,
  );
  const misclassifiedMeasuredOperation = validMeasuredCommand({
    version: 1,
    runId: operationRunId,
    stageId: 'premise',
    operationId: 'misclassified-command',
    kind: 'remote-mutation',
    action: 'misclassify a local subprocess',
    command: {
      executable: process.execPath,
      args: ['--version'],
      cwd: GIT_CONTEXT,
    },
  });
  const forbiddenMeasuredMerge = validMeasuredCommand({
    version: 1,
    runId: operationRunId,
    stageId: 'premise',
    operationId: 'forbidden-merge',
    kind: 'remote-mutation',
    action: 'attempt a forbidden merge',
    command: {
      executable: 'gh',
      args: ['pr', 'merge', '1'],
      cwd: GIT_CONTEXT,
    },
  });
  const committedMutationInput = {
    version: 1,
    runId: operationRunId,
    stageId: 'premise',
    operationId: 'committed-remote-mutation',
    kind: 'remote-mutation',
    action: 'exercise committed mutation replay protection',
    command: {
      executable: 'gh',
      args: ['issue', 'edit', '1', '--add-label', 'committed-fixture-label'],
      cwd: GIT_CONTEXT,
    },
  };
  let committedMutationExecutions = 0;
  const committedMutation = runMeasuredOperation(
    committedMutationInput,
    operationStore,
    () => {
      committedMutationExecutions += 1;
      return {
        error: null,
        signal: null,
        status: 0,
        stdout: '',
        stderr: '',
      };
    },
  );
  const replayedCommittedMutation = runMeasuredOperation(
    {
      ...committedMutationInput,
      operationId: 'replayed-committed-remote-mutation',
    },
    operationStore,
    () => {
      committedMutationExecutions += 1;
      return {
        error: null,
        signal: null,
        status: 0,
        stdout: '',
        stderr: '',
      };
    },
  );
  const preparedMutationInput = {
    version: 1,
    runId: operationRunId,
    stageId: 'premise',
    operationId: 'prepared-remote-mutation',
    kind: 'remote-mutation',
    action: 'exercise durable mutation ambiguity',
    command: {
      executable: 'gh',
      args: ['issue', 'edit', '1', '--add-label', 'fixture-label'],
      cwd: GIT_CONTEXT,
    },
  };
  const preparedMutation = prepareRemoteMutationIntent(
    preparedMutationInput,
    operationStore,
  );
  let ambiguousMutationExecuted = false;
  const ambiguousMutation = runMeasuredOperation(
    preparedMutationInput,
    operationStore,
    () => {
      ambiguousMutationExecuted = true;
      return {};
    },
  );
  let freshMutationExecuted = false;
  const freshMutationAfterAmbiguity = runMeasuredOperation(
    {
      ...preparedMutationInput,
      operationId: 'fresh-id-after-ambiguous-mutation',
      command: {
        ...preparedMutationInput.command,
        args: ['issue', 'edit', '2', '--add-label', 'different-fixture-label'],
      },
    },
    operationStore,
    () => {
      freshMutationExecuted = true;
      return {};
    },
  );
  const globalGitPushClassification = measuredOperationKind('git', [
    '-C',
    GIT_CONTEXT,
    'push',
    'origin',
    'HEAD:refs/heads/fixture',
  ]);
  const unknownGhClassification = measuredOperationKind('gh', [
    'gist',
    'create',
    'fixture.txt',
  ]);
  const localGitClassifications = [
    ['reset', '--hard', 'origin/main'],
    ['revert', '--no-edit', 'HEAD'],
    ['stash', 'push'],
    ['clean', '-fd'],
    ['rm', '--cached', 'fixture.txt'],
    ['mv', 'fixture.txt', 'renamed.txt'],
  ].map((args) => measuredOperationKind('git', ['-C', GIT_CONTEXT, ...args]));
  const compactMutationClassifications = [
    ['api', '-XPOST', 'repos/example/project/issues'],
    ['api', '-XPATCH', 'repos/example/project/issues/1'],
    ['api', '-XDELETE', 'repos/example/project/issues/1'],
    ['api', 'repos/example/project/issues', '-fkey=value'],
    ['api', 'repos/example/project/issues', '-Fkey=@fixture.json'],
    ['api', 'repos/example/project/issues', '--meth=GET'],
  ].map((args) => measuredOperationKind('gh', args));
  const retainedDerivedRead = readMeasurements(eventStore);
  const retainedEventsRead = readMeasurementEvents(eventStore, retainedRunId);
  const exportedEvidenceBundle = exportMeasurementEvidenceBundle(
    ['e23e4567-e89b-42d3-a456-426614174001'],
    eventStore,
  );
  if (!exportedEvidenceBundle.ok) {
    throw new Error(
      `fixture evidence bundle export failed: ${exportedEvidenceBundle.errors.join('; ')}`,
    );
  }
  const portableBundleFile = join(
    selfTestTemporaryRoot(),
    `autoloop-measurement-evidence-${randomUUID()}.json`,
  );
  writeFileSync(portableBundleFile, exportedEvidenceBundle.source, { mode: 0o600 });
  const portableBundleLoad = loadMeasurementEvidenceBundleAt(
    portableBundleFile,
    exportedEvidenceBundle.sha256,
    ['e23e4567-e89b-42d3-a456-426614174001'],
  );
  const portableBundleWrongDigest = loadMeasurementEvidenceBundleAt(
    portableBundleFile,
    '0'.repeat(64),
    ['e23e4567-e89b-42d3-a456-426614174001'],
  );
  const tamperedStoredEvent = JSON.parse(
    readFileSync(retainedEventWrites[2].path, 'utf8'),
  );
  tamperedStoredEvent.payload.telemetry.promptTokens.value += 1;
  writeFileSync(
    retainedEventWrites[2].path,
    `${JSON.stringify(tamperedStoredEvent)}\n`,
    { mode: 0o600 },
  );
  const tamperedDerivedRead = readMeasurements(eventStore);
  const refusedRecordCli = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), '--record'],
    { input: JSON.stringify(valid), encoding: 'utf8' },
  );
  const pendingPolicyFile = join(
    selfTestTemporaryRoot(),
    `autoloop-measurement-policy-${randomUUID()}.json`,
  );
  writeFileSync(pendingPolicyFile, canonicalPendingPolicy, { mode: 0o600 });
  const pendingPolicyFileCheck = checkBudgetPolicyAt(pendingPolicyFile);
  const missingPolicyFileCheck = checkBudgetPolicyAt(`${pendingPolicyFile}.missing`);
  const activePolicyFile = join(
    selfTestTemporaryRoot(),
    `autoloop-active-measurement-policy-${randomUUID()}.json`,
  );
  writeFileSync(
    activePolicyFile,
    canonicalBudgetPolicy(activeBudgetPolicy),
    { mode: 0o600 },
  );
  const missingPortableEvidenceCheck = checkBudgetPolicyAt(
    activePolicyFile,
    selfTestTemporaryRoot(),
  );
  const tempDirectory = join(selfTestTemporaryRoot(), `autoloop-measurement-${randomUUID()}`);
  const persisted = persistMeasurement(valid, tempDirectory);
  const duplicate = persistMeasurement(valid, tempDirectory);
  writeFileSync(join(tempDirectory, `.tmp-${randomUUID()}`), '{"partial":', { mode: 0o600 });
  const stored = readMeasurements(tempDirectory);
  const persistedMode = lstatSync(persisted.path).mode & 0o777;
  const duplicateInput = [valid, { ...valid, unit: { ...valid.unit, timing: {
    ...valid.unit.timing,
    totalMs: 101,
    activeMs: 71,
  } } }];
  const duplicateSummary = summarizeMeasurements(duplicateInput);
  const duplicateComparison = compareCheckpoints(duplicateInput);
  const untrustedSource = buildBudgetSource(fixtureRecords(20, 'safe-system'));
  const mutatedSourceRecords = trustFixtureRecords(fixtureRecords(100, 'safe-system'));
  mutatedSourceRecords[1].unit.timing.steps.selection += 1;
  const mutatedSource = buildBudgetSource(mutatedSourceRecords);
  const mutatedConfigRecords = trustFixtureRecords(fixtureRecords(100, 'safe-system'));
  mutatedConfigRecords[1].configFingerprint = 'f'.repeat(64);
  const mutatedConfigSource = buildBudgetSource(mutatedConfigRecords);
  const mutatedIntentRecords = trustFixtureRecords(fixtureRecords(100, 'safe-system'));
  mutatedIntentRecords[1].intent.source = 'relaunch';
  mutatedIntentRecords[1].unit.outcomes.recovery = {
    resumeKind: 'resumed',
    recoveryKind: 'resumed',
    contextParks: 1,
  };
  const mutatedIntentSource = buildBudgetSource(mutatedIntentRecords);
  const mutatedOutcomeRecords = trustFixtureRecords(fixtureRecords(100, 'safe-system'));
  mutatedOutcomeRecords[1].unit.outcomes.gate.result = 'after-retry';
  const mutatedOutcomeSource = buildBudgetSource(mutatedOutcomeRecords);
  const roundGap = structuredClone(valid);
  roundGap.segments = roundGap.segments.filter((segment) => segment.id !== 'review-1');
  roundGap.unit.dispatch.count -= 1;
  const duplicateRound = structuredClone(valid);
  duplicateRound.segments.splice(3, 0, structuredClone(duplicateRound.segments[2]));
  duplicateRound.segments[3].id = 'review-1-copy';
  duplicateRound.unit.dispatch.count += 1;
  const multipleGates = structuredClone(valid);
  multipleGates.segments.splice(5, 0, {
    ...structuredClone(multipleGates.segments[4]),
    id: 'gate-copy',
  });
  const multipleDeliveries = structuredClone(valid);
  multipleDeliveries.segments.push({
    ...structuredClone(multipleDeliveries.segments.at(-1)),
    id: 'delivery-copy',
  });
  const deliveryBeforeGate = structuredClone(valid);
  [deliveryBeforeGate.segments[4], deliveryBeforeGate.segments[5]] = [
    deliveryBeforeGate.segments[5],
    deliveryBeforeGate.segments[4],
  ];
  const missingImplementation = structuredClone(valid);
  missingImplementation.segments = missingImplementation.segments.filter(
    (segment) => segment.stage !== 'implementation',
  );
  missingImplementation.unit.dispatch.count -= 1;
  const completedAtReview = structuredClone(valid);
  completedAtReview.segments = completedAtReview.segments.slice(0, 4);
  completedAtReview.unit.dispatch.count = 4;
  completedAtReview.unit.outcomes.terminal.stage = 'code-review';
  const earlyPlanFailure = structuredClone(valid);
  earlyPlanFailure.segments = earlyPlanFailure.segments.slice(
    0,
    earlyPlanFailure.segments.findIndex((segment) => segment.stage === 'plan-review') + 1,
  );
  earlyPlanFailure.unit.dispatch = {
    ...earlyPlanFailure.unit.dispatch,
    count: 1,
    durationMs: 5,
    reviewRounds: 0,
  };
  for (const key of UNIT_TELEMETRY_KEYS) {
    const values = earlyPlanFailure.segments.map(
      (segment) => observationValue(segment.telemetry[key]),
    );
    earlyPlanFailure.unit.telemetry[key] = values.every((value) => value !== null)
      ? observed(values.reduce((sum, value) => sum + value, 0))
      : unavailable('early plan failure did not expose this field');
  }
  earlyPlanFailure.unit.outcomes.terminal = {
    status: 'blocked',
    stage: 'plan-review',
    reason: 'fixture plan rejected',
  };
  earlyPlanFailure.unit.outcomes.gate = { result: 'not-run', localGreenCiRed: false };
  const completedFailedGate = structuredClone(valid);
  completedFailedGate.unit.outcomes.gate.result = 'failed';
  const missingPremise = structuredClone(valid);
  missingPremise.segments = missingPremise.segments.filter(
    (segment) => segment.stage !== 'premise',
  );
  const incoherentSelection = structuredClone(valid);
  incoherentSelection.unit.timing.timeToFirstSelectionMs = 11;
  const failedAtGate = structuredClone(valid);
  const removedDelivery = failedAtGate.segments.pop();
  failedAtGate.unit.outcomes.terminal = {
    status: 'failed',
    stage: 'gate',
    reason: 'fixture gate failed',
  };
  failedAtGate.unit.outcomes.gate.result = 'failed';
  for (const key of UNIT_TELEMETRY_KEYS) {
    if (failedAtGate.unit.telemetry[key].status === 'observed') {
      failedAtGate.unit.telemetry[key].value -=
        observationValue(removedDelivery.telemetry[key]) ?? 0;
    }
  }
  const failedComparisonRecord = structuredClone(failedAtGate);
  failedComparisonRecord.recordId = 'd23e4567-e89b-42d3-a456-426614174000';
  failedComparisonRecord.observation = {
    runId: 'd23e4567-e89b-42d3-a456-426614174001',
    unitId: 'failed-comparison',
    terminalEvidenceFingerprint: 'd'.repeat(64),
  };
  const failedOutcomeComparison = compareCheckpoints([
    comparisonLegacy[0],
    failedComparisonRecord,
  ]);
  const hugeNumberRecord = structuredClone(valid);
  hugeNumberRecord.unit.calls.githubApi = 1e308;
  const hugeBudgetSource = buildBudgetSource(trustFixtureRecords(
    fixtureRecords(100, 'safe-system').map((recordValue) => {
      const hugeRecord = structuredClone(recordValue);
      hugeRecord.unit.calls.githubApi = 1e308;
      return hugeRecord;
    }),
  ));
  const formerlyAdmittedOverflowRecord = structuredClone(valid);
  formerlyAdmittedOverflowRecord.unit.dispatch.rebuts.accepted = Math.floor(
    Number.MAX_SAFE_INTEGER / MAX_STORE_RECORDS,
  );
  const aggregateBoundaryRecords = fixtureRecords(
    Math.floor(MAX_STORE_RECORDS / 2) + 1,
    'safe-system',
  ).map((recordValue) => {
    const aggregateRecord = structuredClone(recordValue);
    aggregateRecord.unit.dispatch.rebuts.accepted = MAX_MEASUREMENT_NUMBER;
    aggregateRecord.unit.dispatch.rebuts.rejected = MAX_MEASUREMENT_NUMBER - 1;
    return aggregateRecord;
  });
  const aggregateBoundarySummary = summarizeMeasurements(aggregateBoundaryRecords);
  const aggregateBoundaryRate = aggregateBoundarySummary.unitCohorts[0]
    ?.rates['review.acceptedRebut'];
  const allObservedUnitUnavailable = structuredClone(valid);
  allObservedUnitUnavailable.segments.forEach((segment) => {
    segment.telemetry.reasoningTokens = observed(0);
  });
  const freshResumed = structuredClone(valid);
  freshResumed.unit.outcomes.recovery.resumeKind = 'resumed';
  freshResumed.unit.outcomes.recovery.recoveryKind = 'resumed';
  const notRunRed = structuredClone(valid);
  notRunRed.unit.outcomes.gate = { result: 'not-run', localGreenCiRed: true };
  const pitcrew = structuredClone(valid);
  pitcrew.intent.flow = 'pitcrew';
  const removedPlanning = pitcrew.segments.filter(
    (segment) => ['planning', 'plan-review'].includes(segment.stage),
  );
  pitcrew.segments = pitcrew.segments.filter(
    (segment) => !['planning', 'plan-review'].includes(segment.stage),
  );
  pitcrew.unit.dispatch.count -= 1;
  pitcrew.unit.dispatch.durationMs -=
    removedPlanning.find((segment) => segment.stage === 'plan-review').timing.totalMs;
  for (const key of UNIT_TELEMETRY_KEYS) {
    if (pitcrew.unit.telemetry[key].status === 'observed') {
      pitcrew.unit.telemetry[key].value -= removedPlanning.reduce(
        (sum, segment) => sum + (observationValue(segment.telemetry[key]) ?? 0),
        0,
      );
    }
  }
  const relaunch = structuredClone(valid);
  relaunch.intent.source = 'relaunch';
  relaunch.unit.outcomes.recovery = {
    resumeKind: 'resumed',
    recoveryKind: 'resumed',
    contextParks: 1,
  };
  const recoverySegment = fixtureSegment({
    id: 'recovery',
    stage: 'recovery',
    requestedRoute: 'claude.native',
    totalMs: 5,
  });
  relaunch.segments.splice(2, 0, recoverySegment);
  for (const key of UNIT_TELEMETRY_KEYS) {
    if (relaunch.unit.telemetry[key].status === 'observed') {
      relaunch.unit.telemetry[key].value +=
        observationValue(recoverySegment.telemetry[key]) ?? 0;
    }
  }
  const providerChanged = structuredClone(valid);
  providerChanged.recordId = '723e4567-e89b-42d3-a456-426614174000';
  providerChanged.observation = {
    ...providerChanged.observation,
    runId: '723e4567-e89b-42d3-a456-426614174001',
    terminalEvidenceFingerprint: '7'.repeat(64),
  };
  providerChanged.segments[0].telemetry.provider = observed('other-provider');
  const providerSummary = summarizeMeasurements([valid, providerChanged]);
  const nativeBare = structuredClone(valid);
  nativeBare.recordId = 'd23e4567-e89b-42d3-a456-426614174000';
  nativeBare.observation = {
    ...nativeBare.observation,
    runId: 'd23e4567-e89b-42d3-a456-426614174001',
    terminalEvidenceFingerprint: 'd'.repeat(64),
  };
  nativeBare.selector = 'native';
  nativeBare.requestedEngine = 'claude';
  nativeBare.requestedRoute = 'claude.native';
  nativeBare.segments.forEach((segment) => {
    segment.requestedRoute = 'claude.native';
    segment.actualRoute = 'claude.native';
    segment.adapter = 'claude.native';
    segment.telemetry.provider = observed('anthropic');
    segment.telemetry.model = observed('claude-fixture');
    segment.telemetry.engine = observed('claude.native');
  });
  const nativeExplicit = structuredClone(nativeBare);
  nativeExplicit.recordId = 'e23e4567-e89b-42d3-a456-426614174000';
  nativeExplicit.observation = {
    ...nativeExplicit.observation,
    runId: 'e23e4567-e89b-42d3-a456-426614174001',
    terminalEvidenceFingerprint: 'e'.repeat(64),
  };
  nativeExplicit.selector = 'claude';
  const nativeSelectorSummary = summarizeMeasurements([nativeBare, nativeExplicit]);
  const arbitraryEvidence = structuredClone(valid);
  arbitraryEvidence.unit.outcomes.avoidedRework.avoidedTime = {
    status: 'verified',
    value: 10,
    unit: 'milliseconds',
    method: 'non-mutating-replay',
    evidence: {
      fingerprint: 'e'.repeat(64),
      observedValue: 100,
      counterfactualValue: 110,
      controlRecords: [],
    },
  };
  const matchedEvidence = fixtureMatchedControl();
  const matchedSummary = summarizeMeasurements([
    matchedEvidence.subject,
    matchedEvidence.control,
  ]);
  const absentControlSummary = summarizeMeasurements([matchedEvidence.subject]);
  const wrongControl = fixtureMatchedControl(
    {},
    { checkpointEndpointFingerprint: 'f'.repeat(64) },
  );
  const wrongControlSummary = summarizeMeasurements([wrongControl.subject, wrongControl.control]);
  const inconsistentEvidence = fixtureMatchedControl();
  inconsistentEvidence.subject.unit.outcomes.avoidedRework.avoidedTime.evidence.counterfactualValue += 1;
  const inconsistentEvidenceSummary = summarizeMeasurements([
    inconsistentEvidence.subject,
    inconsistentEvidence.control,
  ]);
  const externalDirectory = join(selfTestTemporaryRoot(), `autoloop-measurement-external-${randomUUID()}`);
  mkdirSync(externalDirectory, { mode: 0o700 });
  const externalPath = join(externalDirectory, `${valid.recordId}.json`);
  writeFileSync(externalPath, `${JSON.stringify(valid)}\n`, { mode: 0o600 });
  const symlinkStore = join(selfTestTemporaryRoot(), `autoloop-measurement-symlink-${randomUUID()}`);
  persistMeasurement({ ...valid, recordId: '823e4567-e89b-42d3-a456-426614174000' }, symlinkStore);
  symlinkSync(externalPath, join(symlinkStore, `${valid.recordId}.json`));
  const symlinkRead = readMeasurements(symlinkStore);
  const oversizedStore = join(selfTestTemporaryRoot(), `autoloop-measurement-oversized-${randomUUID()}`);
  persistMeasurement({ ...valid, recordId: '923e4567-e89b-42d3-a456-426614174000' }, oversizedStore);
  const oversizedId = 'a23e4567-e89b-42d3-a456-426614174000';
  writeFileSync(join(oversizedStore, `${oversizedId}.json`), 'x'.repeat(MAX_RECORD_BYTES + 1), {
    mode: 0o600,
  });
  const oversizedRead = readMeasurements(oversizedStore);
  const widenedStore = join(selfTestTemporaryRoot(), `autoloop-measurement-mode-${randomUUID()}`);
  const widenedPersist = persistMeasurement(valid, widenedStore);
  const widenedDescriptor = openSync(widenedPersist.path, constants.O_RDONLY);
  fchmodSync(widenedDescriptor, 0o644);
  closeSync(widenedDescriptor);
  const widenedRead = readMeasurements(widenedStore);
  const widenedDirectoryStore = join(
    selfTestTemporaryRoot(),
    `autoloop-measurement-directory-mode-${randomUUID()}`,
  );
  persistMeasurement(valid, widenedDirectoryStore);
  const directoryDescriptor = openSync(
    widenedDirectoryStore,
    constants.O_RDONLY | constants.O_DIRECTORY,
  );
  fchmodSync(directoryDescriptor, 0o755);
  closeSync(directoryDescriptor);
  const widenedDirectoryRead = readMeasurements(widenedDirectoryStore);
  const missingAuthorityStore = join(
    selfTestTemporaryRoot(),
    `autoloop-measurement-missing-authority-${randomUUID()}`,
  );
  const missingAuthorityInitial = persistMeasurement(valid, missingAuthorityStore);
  unlinkSync(join(missingAuthorityStore, STORE_KEY_FILE));
  const missingAuthorityRead = readMeasurements(missingAuthorityStore);
  const missingAuthorityWrite = persistMeasurement({
    ...valid,
    recordId: 'ab3e4567-e89b-42d3-a456-426614174000',
  }, missingAuthorityStore);
  const emptyStore = join(selfTestTemporaryRoot(), `autoloop-measurement-empty-${randomUUID()}`);
  mkdirSync(emptyStore, { mode: 0o700 });
  const emptyStoreRead = readMeasurements(emptyStore);
  const emptyStoreWrite = persistMeasurement(valid, emptyStore);
  const publicationStore = join(selfTestTemporaryRoot(), `autoloop-measurement-publication-${randomUUID()}`);
  const publicationPersist = persistMeasurement(valid, publicationStore);
  linkSync(
    publicationPersist.path,
    join(publicationStore, `.tmp-${randomUUID()}`),
  );
  const recoveredPublication = readMeasurements(publicationStore);
  const invalidAvoidedStore = join(
    selfTestTemporaryRoot(),
    `autoloop-measurement-invalid-avoided-${randomUUID()}`,
  );
  const invalidAvoided = structuredClone(valid);
  invalidAvoided.recordId = 'ac3e4567-e89b-42d3-a456-426614174000';
  invalidAvoided.observation = {
    ...invalidAvoided.observation,
    runId: 'ac3e4567-e89b-42d3-a456-426614174001',
    unitId: 'invalid-avoided',
    terminalEvidenceFingerprint: 'a'.repeat(64),
  };
  const absentEvidence = {
    observedValue: invalidAvoided.unit.timing.totalMs,
    counterfactualValue: invalidAvoided.unit.timing.totalMs + 10,
    controlRecords: [{
      recordId: 'ad3e4567-e89b-42d3-a456-426614174000',
      contentFingerprint: 'd'.repeat(64),
    }],
  };
  invalidAvoided.unit.outcomes.avoidedRework.avoidedTime = {
    status: 'verified',
    value: 10,
    unit: 'milliseconds',
    method: 'matched-control',
    evidence: {
      ...absentEvidence,
      fingerprint: fingerprint({
        method: 'matched-control',
        unit: 'milliseconds',
        ...absentEvidence,
      }),
    },
  };
  persistMeasurement(invalidAvoided, invalidAvoidedStore);
  const invalidAvoidedSummary = summarizeMeasurementStore(invalidAvoidedStore);
  const spoofedRevision = persistMeasurement({
    ...valid,
    revision: 'f'.repeat(40),
    recordId: 'ae3e4567-e89b-42d3-a456-426614174000',
  }, join(selfTestTemporaryRoot(), `autoloop-measurement-spoof-${randomUUID()}`));
  const legacyImport = persistMeasurement({
    ...valid,
    checkpoint: 'legacy-workflow',
    recordId: 'af3e4567-e89b-42d3-a456-426614174000',
  }, join(selfTestTemporaryRoot(), `autoloop-measurement-legacy-${randomUUID()}`));
  const futureRecord = structuredClone(valid);
  futureRecord.capturedAt = '2999-01-01T00:00:00.000Z';
  const semanticClones = Array.from({ length: 100 }, (_, index) => ({
    ...structuredClone(valid),
    recordId: `b13e4567-e89b-42d3-a456-${String(426614174000 + index).padStart(12, '0')}`,
    observation: {
      ...valid.observation,
      runId: `b23e4567-e89b-42d3-a456-${String(426614174000 + index).padStart(12, '0')}`,
      unitId: `clone-${index}`,
      terminalEvidenceFingerprint: createHash('sha256').update(`clone-${index}`).digest('hex'),
    },
  }));
  const semanticCloneSummary = summarizeMeasurements(semanticClones);
  const repeatedTerminalEvidence = fixtureRecords(100, 'safe-system');
  repeatedTerminalEvidence.forEach((recordValue) => {
    recordValue.observation.terminalEvidenceFingerprint = 'f'.repeat(64);
  });
  const repeatedTerminalSummary = summarizeMeasurements(repeatedTerminalEvidence);
  const duplicateObservation = [
    valid,
    {
      ...structuredClone(valid),
      recordId: 'b33e4567-e89b-42d3-a456-426614174000',
      unit: {
        ...structuredClone(valid.unit),
        timing: {
          ...structuredClone(valid.unit.timing),
          totalMs: 101,
          activeMs: 71,
        },
      },
    },
  ];
  const duplicateObservationSummary = summarizeMeasurements(duplicateObservation);
  const nestingBomb = {};
  let nestingCursor = nestingBomb;
  for (let depth = 0; depth < MAX_DATA_DEPTH + 5; depth += 1) {
    nestingCursor.child = {};
    nestingCursor = nestingCursor.child;
  }
  const nestingBombRecord = { ...valid, retiredBomb: nestingBomb };
  const hostileWidthFixture = (array) => {
    const target = array ? [] : {};
    const keys = Array.from(
      { length: MAX_STORE_RECORDS + 1 },
      (_, index) => `key${index}`,
    );
    if (array) keys.unshift('length');
    let descriptorReads = 0;
    return {
      value: new Proxy(target, {
        ownKeys: () => keys,
        getOwnPropertyDescriptor: (object, key) => {
          descriptorReads += 1;
          if (key === 'length') return Reflect.getOwnPropertyDescriptor(object, key);
          return {
            configurable: true,
            enumerable: true,
            value: null,
            writable: true,
          };
        },
      }),
      descriptorReads: () => descriptorReads,
    };
  };
  const wideObject = hostileWidthFixture(false);
  const wideObjectGraph = validateDataGraph(wideObject.value);
  const wideNamedArray = hostileWidthFixture(true);
  const wideNamedArrayGraph = validateDataGraph(wideNamedArray.value);
  const oversizedDenseErrors = [];
  const oversizedDense = new Array(MAX_STORE_RECORDS + 1).fill(null);
  const oversizedDenseResult = denseArray(
    oversizedDenseErrors,
    'fixture.large',
    oversizedDense,
    0,
    MAX_STORE_RECORDS,
  );
  const publishReadStore = join(
    selfTestTemporaryRoot(),
    `autoloop-measurement-publish-read-${randomUUID()}`,
  );
  persistMeasurement(valid, publishReadStore);
  const racingRecord = fixtureRecord(101, {
    recordId: 'b43e4567-e89b-42d3-a456-426614174000',
    observation: {
      runId: 'b43e4567-e89b-42d3-a456-426614174001',
      unitId: 'race-reader',
      terminalEvidenceFingerprint: '4'.repeat(64),
    },
  });
  const publishReadRace = await concurrentPublishAndRead(
    racingRecord,
    publishReadStore,
    2,
  );
  const publishReadFinal = readMeasurements(publishReadStore);
  const staleOwner = {
    version: 1,
    pid: process.pid,
    processIdentity: 'proc:stale-process-instance',
    nonce: randomUUID(),
    storeFingerprint: fingerprint(publishReadStore),
    createdAt: new Date().toISOString(),
  };
  const staleOwnerOid = gitExec(['hash-object', '-w', '--stdin'], {
    encoding: 'utf8',
    input: `${JSON.stringify(staleOwner)}\n`,
    stdio: ['pipe', 'pipe', 'ignore'],
  }).trim();
  const staleInstalled = updateStoreLock(
    staleOwnerOid,
    '0'.repeat(staleOwnerOid.length),
  );
  const staleRecovered = readMeasurements(publishReadStore);
  const staleReleased = readStoreLockOid() === null;
  const deadOwner = {
    ...staleOwner,
    pid: 99_999_999,
    processIdentity: null,
    nonce: randomUUID(),
  };
  const deadOwnerOid = gitExec(['hash-object', '-w', '--stdin'], {
    input: `${JSON.stringify(deadOwner)}\n`,
    stdio: ['pipe', 'pipe', 'ignore'],
  }).trim();
  const deadInstalled = updateStoreLock(
    deadOwnerOid,
    '0'.repeat(deadOwnerOid.length),
  );
  const deadRecovered = readMeasurements(publishReadStore);
  const deadReleased = readStoreLockOid() === null;
  const currentProcessIdentity = processIdentity(process.pid);
  const zombieOwnerIsDead = processOwnerAlive(
    { pid: process.pid, processIdentity: currentProcessIdentity },
    () => ({ identity: currentProcessIdentity, state: 'Z' }),
    () => {},
  ) === false;
  const unverifiableOwnerStaysLive = processOwnerAlive(
    { pid: process.pid, processIdentity: currentProcessIdentity },
    () => ({ identity: null, state: null }),
    () => {},
  ) === true;
  const symbolicTargetRef = `refs/autoloop/measurement-lock-target-${randomUUID()}`;
  const zeroOid = '0'.repeat(staleOwnerOid.length);
  const symbolicTargetInstalled = gitSpawn(
    ['update-ref', '--no-deref', symbolicTargetRef, staleOwnerOid, zeroOid],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  ).status === 0;
  const directLockInstalled = updateStoreLock(staleOwnerOid, zeroOid);
  const racedExpectedOid = readStoreLockOid();
  const symbolicRaceInstalled = gitSpawn(
    ['symbolic-ref', STORE_LOCK_REF, symbolicTargetRef],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  ).status === 0;
  let symbolicReadRejected = false;
  try {
    readStoreLockOid();
  } catch {
    symbolicReadRejected = true;
  }
  let symbolicUpdateRejected = false;
  try {
    updateStoreLock(deadOwnerOid, racedExpectedOid);
  } catch {
    symbolicUpdateRejected = true;
  }
  const stableSymbolicTargetPreserved = gitExec(
    ['rev-parse', '--verify', symbolicTargetRef],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim() === staleOwnerOid;
  const symbolicLockTarget = gitSpawn(
    ['symbolic-ref', '--quiet', STORE_LOCK_REF],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  ).stdout.trim();
  const racedCasUpdated = compareAndSwapStoreLock(deadOwnerOid, racedExpectedOid);
  let racedLockIsDirect = false;
  try {
    racedLockIsDirect = readStoreLockOid() === deadOwnerOid;
  } catch {}
  const racedLockTarget = gitSpawn(
    ['symbolic-ref', '--quiet', STORE_LOCK_REF],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  ).stdout.trim();
  const racedTargetPreserved = gitExec(
    ['rev-parse', '--verify', symbolicTargetRef],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim() === staleOwnerOid;
  const racedRefStateSafe = racedCasUpdated
    ? racedLockIsDirect && racedLockTarget === ''
    : racedLockTarget === symbolicTargetRef;
  gitSpawn(
    ['update-ref', '--no-deref', '-d', STORE_LOCK_REF],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
  const releaseTargetRef = `refs/autoloop/measurement-release-target-${randomUUID()}`;
  const releaseTargetInstalled = gitSpawn(
    ['update-ref', '--no-deref', releaseTargetRef, deadOwnerOid, zeroOid],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  ).status === 0;
  const releaseLockInstalled = updateStoreLock(deadOwnerOid, zeroOid);
  const releaseExpectedOid = readStoreLockOid();
  const releaseRaceInstalled = gitSpawn(
    ['symbolic-ref', STORE_LOCK_REF, releaseTargetRef],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  ).status === 0;
  const racedReleaseDeleted = compareAndSwapStoreLock(null, releaseExpectedOid);
  const releaseTargetPreserved = gitExec(
    ['rev-parse', '--verify', releaseTargetRef],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim() === deadOwnerOid;
  const releaseLockAbsent = readStoreLockOid() === null;
  gitSpawn(
    ['update-ref', '--no-deref', '-d', STORE_LOCK_REF],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
  gitSpawn(
    ['update-ref', '--no-deref', '-d', symbolicTargetRef],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
  gitSpawn(
    ['update-ref', '--no-deref', '-d', releaseTargetRef],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
  const missingSymbolicTargetRef =
    `refs/autoloop/measurement-missing-target-${randomUUID()}`;
  const brokenSymbolicInstalled = gitSpawn(
    ['symbolic-ref', STORE_LOCK_REF, missingSymbolicTargetRef],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  ).status === 0;
  let brokenSymbolicRejected = false;
  try {
    readStoreLockOid();
  } catch {
    brokenSymbolicRejected = true;
  }
  gitSpawn(
    ['update-ref', '--no-deref', '-d', STORE_LOCK_REF],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
  const symbolicFixtureClean = readStoreLockOid() === null;
  const hostileGitStore = join(
    selfTestTemporaryRoot(),
    `autoloop-measurement-hostile-git-${randomUUID()}`,
  );
  const hostileGitKeys = [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0',
    'GIT_CONFIG_VALUE_0',
  ];
  const savedGitEnvironment = Object.fromEntries(
    hostileGitKeys.map((key) => [key, process.env[key]]),
  );
  const trustedMeasurementDirectory = measurementDirectory();
  process.env.GIT_DIR = join(hostileGitStore, 'attacker.git');
  process.env.GIT_WORK_TREE = hostileGitStore;
  process.env.GIT_OBJECT_DIRECTORY = join(hostileGitStore, 'objects');
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = 'core.repositoryformatversion';
  process.env.GIT_CONFIG_VALUE_0 = '999';
  let hostileGitRevision;
  let hostileMeasurementDirectory;
  let hostileGitPersist;
  try {
    hostileGitRevision = gitExec(['rev-parse', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    hostileMeasurementDirectory = measurementDirectory();
    hostileGitPersist = persistMeasurement(valid, hostileGitStore);
  } finally {
    for (const key of hostileGitKeys) {
      if (savedGitEnvironment[key] === undefined) delete process.env[key];
      else process.env[key] = savedGitEnvironment[key];
    }
  }
  const hostileGitRead = readMeasurements(hostileGitStore);
  const concurrentStore = join(selfTestTemporaryRoot(), `autoloop-measurement-race-${randomUUID()}`);
  const concurrentStatuses = await concurrentPersist(valid, concurrentStore);
  const concurrentRead = readMeasurements(concurrentStore);
  const invalidWriteDirectory = join(selfTestTemporaryRoot(), `autoloop-measurement-invalid-${randomUUID()}`);
  const invalidWrite = persistMeasurement({ ...valid, workload: '' }, invalidWriteDirectory);
  let invalidFinalExists = false;
  try {
    lstatSync(join(invalidWriteDirectory, `${valid.recordId}.json`));
    invalidFinalExists = true;
  } catch {}
  const oversizedInput = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url)],
    { input: Buffer.alloc(MAX_INPUT_BYTES + 1, 0x20) },
  );
  rmSync(tempDirectory, { recursive: true, force: true });
  rmSync(externalDirectory, { recursive: true, force: true });
  rmSync(symlinkStore, { recursive: true, force: true });
  rmSync(oversizedStore, { recursive: true, force: true });
  rmSync(widenedStore, { recursive: true, force: true });
  rmSync(widenedDirectoryStore, { recursive: true, force: true });
  rmSync(missingAuthorityStore, { recursive: true, force: true });
  rmSync(emptyStore, { recursive: true, force: true });
  rmSync(publicationStore, { recursive: true, force: true });
  rmSync(invalidAvoidedStore, { recursive: true, force: true });
  rmSync(publishReadStore, { recursive: true, force: true });
  rmSync(hostileGitStore, { recursive: true, force: true });
  rmSync(concurrentStore, { recursive: true, force: true });
  rmSync(eventStore, { recursive: true, force: true });
  rmSync(operationStore, { recursive: true, force: true });
  rmSync(retryCaptureStore, { recursive: true, force: true });
  unlinkSync(pendingPolicyFile);
  unlinkSync(activePolicyFile);
  unlinkSync(portableBundleFile);
  const cases = [
    ['mixed-route unit is valid', validateMeasurement(valid).ok],
    ['prompt intent provenance cannot be omitted',
      !validateMeasurement(missingIntentProvenance).ok],
    ['prompt intent provenance cannot be upgraded or substituted',
      !validateMeasurement(substitutedIntentProvenance).ok],
    ['measurement declaration binds the accepted Runtime prompt provenance',
      validateRuntimeMeasurementBindingInput(retryBinding).ok
      && !validateRuntimeMeasurementBindingInput(omittedRetryBinding).ok
      && !validateRuntimeMeasurementBindingInput(substitutedRetryBinding).ok],
    ['measurement starts from the exact Runtime run before route artifacts exist',
      validateRuntimeMeasurementBindingInput(retryBinding).ok
      && !validateRuntimeMeasurementBindingInput(lateRetryBinding).ok],
    ['authenticated run start cannot omit prompt intent provenance',
      !omittedRunStartProvenanceDerivation.ok],
    ['authenticated Runtime receipts cannot substitute prompt intent provenance',
      !substitutedReceiptProvenanceDerivation.ok],
    ['event finalization preserves prompt intent provenance',
      derivedFromEvents.ok
      && derivedFromEvents.record.intentProvenance === INTENT_PROVENANCE],
    ['summary and budget mode identities preserve prompt intent provenance',
      summary.unitCohorts[0]?.cohort.identity.intentProvenance === INTENT_PROVENANCE
      && source.ok
      && source.mode.intentProvenance === INTENT_PROVENANCE
      && budget.mode.intentProvenance === INTENT_PROVENANCE],
    ['unknown and retired top-level keys are rejected', !validateMeasurement(unknown).ok],
    [
      'legacyProfile is the only admitted retired key',
      validateMeasurement({ ...valid, legacyProfile: 'codex' }).ok,
    ],
    ['unsupported host-selector pair is rejected', !validateMeasurement(impossible).ok],
    ['adapter must equal the actual closed-catalog route', !validateMeasurement(invalidAdapter).ok],
    ['Runtime may report an explicit same-route degraded posture',
      validateMeasurement(sameRouteDegradation).ok],
    ['unknown nested telemetry keys are rejected', !validateMeasurement(unknownNested).ok],
    ['stage and lane routing is enforced', !validateMeasurement(invalidLaneRoute).ok],
    ['public callers cannot author Runtime unit context', !publicUnitContextCapture.ok],
    ['retry receipt binds its initial plan and captures under its terminal plan',
      retryStartCapture.ok
      && retryUnitCapture.ok
      && retryStageCapture.ok
      && retryRuntime.initialPlan.fingerprint
        !== retryRuntime.terminalPlan.fingerprint
      && retryRuntime.receipt.attempts[0].planFingerprint
        === retryRuntime.initialPlan.fingerprint
      && retryRuntime.receipt.planFingerprint
        === retryRuntime.terminalPlan.fingerprint
      && retryDispatchCapture.ok
      && retryCapturedEvents.ok
      && retryCapturedEvents.events.some((eventValue) =>
        eventValue.kind === 'dispatch'
        && eventValue.payload.runtimeReceipt.envelope.payload.fingerprint
          === retryRuntime.receipt.fingerprint)],
    ['pre-selection wall-clock gaps are included',
      gapDerivation.ok
      && gapDerivation.record.unit.timing.timeToFirstSelectionMs
        === derivedFromEvents.record.unit.timing.timeToFirstSelectionMs + 37],
    ['missing selection cannot finalize', !missingSelectionDerivation.ok],
    ['duplicate selection cannot finalize', !duplicateSelectionDerivation.ok],
    ['later Runtime lane promotion is retained per dispatch',
      promotedDerivation.ok
      && promotedDerivation.record.lane === 'small'
      && promotedDerivation.record.segments.find((segment) =>
        segment.stage === 'code-review').effectiveLane === 'full'],
    ['Runtime outage transitions preserve order and multiplicity',
      outageDerivation.ok
      && outageDerivation.record.outageTransition
        === 'probe>entered>entered>continued'],
    ['sparse segment arrays are rejected', !validateMeasurement(sparse).ok],
    ['comparison context is required on every measurement',
      !validateMeasurement(missingComparisonContext).ok],
    ['checkpoint endpoint is required on every measurement',
      !validateMeasurement(missingCheckpointEndpoint).ok],
    ['avoided claims require their declared evidence method', !validateMeasurement(claim).ok],
    ['arbitrary avoided-evidence hashes are rejected', !validateMeasurement(arbitraryEvidence).ok],
    ['matched controls replay authenticated same-cohort records',
      matchedSummary.invalid.length === 0],
    ['nonexistent avoided-cost controls invalidate the record set',
      absentControlSummary.invalid.length > 0],
    ['wrong-cohort avoided-cost controls invalidate the record set',
      wrongControlSummary.invalid.length > 0],
    ['inconsistent avoided-cost values invalidate authenticated evidence',
      inconsistentEvidenceSummary.invalid.length > 0],
    ['Dev and Pitcrew segment grammars are distinct and valid', validateMeasurement(pitcrew).ok],
    ['relaunch intent reconciles with resumed recovery state', validateMeasurement(relaunch).ok],
    ['round two without round one is rejected', !validateMeasurement(roundGap).ok],
    ['duplicate stage and round is rejected', !validateMeasurement(duplicateRound).ok],
    ['multiple gate segments are rejected', !validateMeasurement(multipleGates).ok],
    ['multiple delivery segments are rejected', !validateMeasurement(multipleDeliveries).ok],
    ['delivery before gate is rejected', !validateMeasurement(deliveryBeforeGate).ok],
    ['missing implementation is rejected', !validateMeasurement(missingImplementation).ok],
    ['completed at an arbitrary segment is rejected', !validateMeasurement(completedAtReview).ok],
    ['legitimate early plan-review failure is retained', validateMeasurement(earlyPlanFailure).ok],
    ['completed units reject a failed gate', !validateMeasurement(completedFailedGate).ok],
    ['completed units require premise cost', !validateMeasurement(missingPremise).ok],
    ['time to first selection reconciles with its unit step',
      !validateMeasurement(incoherentSelection).ok],
    ['failed terminal outcome reconciles with the final gate', validateMeasurement(failedAtGate).ok],
    ['unit unavailable contradicting all-observed segments is rejected',
      !validateMeasurement(allObservedUnitUnavailable).ok],
    ['provider unit totals can retain independently observed aggregate evidence',
      validateMeasurement(evidencedUnitTotal).ok],
    ['unit totals with unavailable segments reject an unproven aggregate',
      !validateMeasurement(unprovenUnitTotal).ok],
    ['provider unit totals reject evidence fingerprints that do not match retained raw evidence',
      !validateMeasurement(mismatchedUnitTotalEvidence).ok],
    ['provider unit totals require retained raw evidence',
      !validateMeasurement(missingRawUnitTotalEvidence).ok],
    ['provider unit totals bind run, unit, metric, provider, and claimed value',
      mismatchedProviderUnitEvidence.every(
        (recordValue) => !validateMeasurement(recordValue).ok,
      )],
    ['arbitrary provider JSON cannot prove a unit total',
      !validateMeasurement(arbitraryProviderUnitEvidence).ok],
    ['fully observed unit totals still require the exact segment sum',
      !validateMeasurement(mismatchedObservedSegmentSum).ok],
    ['fresh invocation cannot claim resumed recovery', !validateMeasurement(freshResumed).ok],
    ['gate not-run cannot report local-green CI-red', !validateMeasurement(notRunRed).ok],
    ['dynamic unit steps are summarized', !!summary.unitCohorts[0]?.metrics['unit.timing.steps.gate']],
    ['segment cohorts retain stage and route', summary.segmentCohorts.some(
      ({ cohort }) =>
        cohort.stage === 'code-review'
        && cohort.actualSegmentRoute === 'claude.native',
    )],
    ['provider identity cannot be pooled', providerSummary.unitCohorts.length === 2],
    ['bare native and explicit same-host selectors remain distinct',
      nativeSelectorSummary.unitCohorts.length === 2],
    ['duplicate IDs invalidate summaries even when contents differ',
      duplicateSummary.invalid.length > 0],
    ['duplicate IDs invalidate checkpoint comparison', !duplicateComparison.ok],
    ['duplicate run/unit observation identity invalidates summaries',
      duplicateObservationSummary.invalid.length > 0],
    ['UUID-renamed semantic clones cannot inflate sample counts',
      semanticCloneSummary.invalid.length > 0
      && semanticCloneSummary.unitCohorts.length === 0],
    ['shared terminal evidence cannot inflate sample counts',
      repeatedTerminalSummary.invalid.length > 0
      && repeatedTerminalSummary.unitCohorts.length === 0],
    ['bounded graph validation rejects nesting bombs without recursion failure',
      !validateMeasurement(nestingBombRecord).ok],
    ['oversized arrays stop before descriptor or element traversal',
      !oversizedDenseResult && oversizedDenseErrors.length === 1],
    ['even median averages the middle pair', totalMetric?.median === 149.5],
    ['nearest-rank p95 is emitted at 20 samples', twenty.unitCohorts[0]
      ?.metrics['unit.timing.totalMs']?.p95 === 118],
    ['p95 is withheld below 20 samples', summarizeMeasurements(
      fixtureRecords(19, 'safe-system'),
    ).unitCohorts[0]?.metrics['unit.timing.totalMs']?.p95 === null],
    ['provisional status is per metric sample count', totalMetric?.provisional === false
      && reasoningMetric?.provisional === true],
    ['raw invocation fingerprints do not split stable 100-run cohorts',
      varyingInvocationSummary.unitCohorts.length === 1
      && varyingInvocationSummary.unitCohorts[0].sampleCount === 100
      && varyingInvocationSource.ok
      && varyingInvocationSummary.unitCohorts[0]
        .invocationEvidence?.capabilityFingerprints.length === 100
      && varyingInvocationSummary.unitCohorts[0]
        .invocationEvidence?.outageFingerprints.length === 100],
    ['configuration fingerprints remain distinct reported cohorts',
      mixedConfigSummary.unitCohorts.length === 2
      && !mixedConfigSource.ok],
    ['stable checkpoint endpoint changes split summary cohorts',
      splitEndpointSummary.unitCohorts.length === 2],
    ['outcome rates retain their own sample count', summary.unitCohorts[0]
      ?.rates['review.acceptedRebut']?.sampleCount === 100],
    ['manual legacy and safe checkpoints compare by observed route set',
      comparison.ok && comparison.matches.length === 1],
    ['stable endpoint permits invocation fingerprints and stage topology to change',
      migrationComparison.ok && migrationComparison.matches.length === 1],
    ['changed comparison context cannot match migration checkpoints',
      changedContextComparison.ok && changedContextComparison.matches.length === 0],
    ['changed provider identity cannot match migration checkpoints',
      changedProviderComparison.ok && changedProviderComparison.matches.length === 0],
    ['changed model identity cannot match migration checkpoints',
      changedModelComparison.ok && changedModelComparison.matches.length === 0],
    ['comparison cannot pool different stable endpoints inside one checkpoint',
      !mixedEndpointComparison.ok],
    ['comparison refuses multiple revisions inside one checkpoint',
      !mixedRevisionComparison.ok],
    ['comparison refuses multiple configurations inside one checkpoint',
      !mixedConfigComparison.ok],
    ['unmatched comparison sides still enforce exact endpoint, revision, and configuration',
      !mixedUnmatchedComparison.ok],
    ['unmatched comparison sides retain invocation evidence distributions',
      unmatchedEvidenceComparison.ok
      && unmatchedEvidenceComparison.unmatched.length === 1
      && unmatchedEvidenceComparison.unmatched[0].legacy?.sampleCount === 2
      && unmatchedEvidenceComparison.unmatched[0].legacy
        ?.invocationEvidence?.capabilityFingerprints.length === 2
      && unmatchedEvidenceComparison.unmatched[0].legacy
        ?.invocationEvidence?.outageFingerprints.length === 2],
    ['changed degradation identity cannot match through delimiter collisions',
      changedDegradationComparison.ok && changedDegradationComparison.matches.length === 0],
    ['unavailable provider, model, or engine identity refuses checkpoint comparison',
      unavailableIdentityComparisons.every((result) => !result.ok)],
    ['non-completed work cannot be presented as checkpoint savings',
      !failedOutcomeComparison.ok],
    ['budget source is exact safe-system cohort evidence', source.ok
      && validateBudgetSpec(budget).ok],
    ['authenticated raw events derive aggregate operation and dispatch counts',
      derivedFromEvents.ok
      && derivedFromEvents.derivation.startRevision === rawEvents[0].revision
      && derivedFromEvents.record.revision === rawEvents.at(-1).revision
      && derivedFromEvents.derivation.startRevision
        === derivedFromEvents.record.revision
      && derivedFromEvents.record.unit.calls.githubApi === 1
      && derivedFromEvents.record.unit.dispatch.count === 4
      && derivedFromEvents.record.provenance === undefined],
    ['public typed capture refuses caller-labelled observed producer evidence',
      !callerObservedOperationCapture.ok],
    ['producer capture fingerprints and retains the exact producer envelope',
      typedOperationCapture.ok
      && typedOperationCapture.event.payload.evidence.envelope
        .payload.executableFingerprint === '1'.repeat(64)
      && !validateMeasurementEventInput(tamperedTypedOperation).ok],
    ['command wrapper executes before retaining an exact observed result',
      operationSeedWrites.every((result) => result.ok)
      && measuredOperation.ok
      && measuredOperation.command.stdout.trim() === process.version
      && measuredOperationRead.ok
      && measuredOperationRead.events.at(-1)?.kind === 'operation'
      && measuredOperationRead.events.at(-1)?.provenance.capture.payloadSource
        === 'command-wrapper-observed'],
    ['command wrapper refuses caller operation-kind misclassification',
      !misclassifiedMeasuredOperation.ok],
    ['structured command policy blocks forbidden merge execution',
      !forbiddenMeasuredMerge.ok],
    ['global Git push syntax is conservatively a remote mutation',
      globalGitPushClassification === 'remote-mutation'],
    ['local Git subcommands classify as subprocess operations',
      localGitClassifications.every((kind) => kind === 'subprocess')],
    ['unknown GitHub CLI shapes are conservatively remote mutations',
      unknownGhClassification === 'remote-mutation'],
    ['compact and abbreviated GitHub API mutation flags require journaling',
      compactMutationClassifications.every((kind) =>
        kind === 'remote-mutation')],
    ['authenticated commit marker prevents replay under a fresh operation identity',
      committedMutation.ok
      && committedMutation.commit?.ok
      && !replayedCommittedMutation.ok
      && committedMutationExecutions === 1],
    ['unresolved remote mutation intents stop before any retry',
      preparedMutation.ok
      && !ambiguousMutation.ok
      && ambiguousMutation.ambiguous === true
      && !ambiguousMutationExecuted],
    ['one unresolved intent blocks every later remote mutation in the run',
      !freshMutationAfterAmbiguity.ok
      && freshMutationAfterAmbiguity.ambiguous === true
      && !freshMutationExecuted],
    ['command wrapper refuses a retained identity before duplicate execution',
      !duplicateMeasuredOperation.ok && !duplicateOperationExecuted],
    ['raw operation replay cannot inflate a derived aggregate',
      !replayedOperationDerivation.ok],
    ['raw stage events cannot be reordered before aggregate derivation',
      !reorderedDerivation.ok],
    ['raw event sets cannot mix run identities', !mixedRunDerivation.ok],
    ['legacy-workflow event streams cannot finalize without import provenance',
      !legacyEventStreamDerivation.ok],
    ['a code-changing run retains its authenticated revision transition',
      revisionTransitionDerivation.ok
      && revisionTransitionDerivation.derivation.startRevision
        === revisionTransitionEvents[0].revision
      && revisionTransitionDerivation.record.revision
        === revisionTransitionEvents.at(-1).revision
      && revisionTransitionDerivation.record.revision
        !== revisionTransitionDerivation.derivation.startRevision
      && revisionTransitionBundle.ok
      && !misboundTransitionStartBundle.ok
      && !misboundTransitionResultBundle.ok],
    ['typed unavailable operation evidence is retained but refuses finalization',
      !unavailableOperationDerivation.ok],
    ['typed unavailable reviewer receipts refuse finalization',
      !unavailableReceiptDerivation.ok],
    ['stage results must equal their retained Runtime route receipts',
      !mismatchedRouteDerivation.ok],
    ['typed unavailable provider identity remains unavailable after derivation',
      unavailableProviderDerivation.ok
      && unavailableProviderDerivation.record.segments[0]
        .telemetry.provider.status === 'unavailable'],
    ['raw event content tampering fails fingerprint replay',
      !tamperedDerivation.ok],
    ['write-once event capture finalizes and replays an authenticated aggregate',
      retainedEventWrites.every((result) => result.ok)
      && retainedFinalization.ok
      && retainedDerivedRead.ok
      && retainedEventsRead.ok
      && retainedDerivedRead.records.length === 1
      && isTrustedDerivedRecord(retainedDerivedRead.records[0])],
    ['portable canonical bundle replays in a clean store and is policy-digest bound',
      exportedEvidenceBundle.ok
      && parseMeasurementEvidenceBundle(exportedEvidenceBundle.source).ok
      && portableBundleLoad.ok
      && portableBundleLoad.records.length === 1
      && isTrustedDerivedRecord(portableBundleLoad.records[0])
      && !portableBundleWrongDigest.ok],
    ['tampering a retained event invalidates its finalized aggregate replay',
      !tamperedDerivedRead.ok
      && tamperedDerivedRead.records.length === 0],
    ['public CLI refuses arbitrary caller-composed aggregate recording',
      refusedRecordCli.status === 1
      && refusedRecordCli.stdout.includes('caller-composed aggregate records are refused')],
    ['pending budget policy is valid but never reported as passed',
      validateBudgetPolicy(pendingBudgetPolicy).ok
      && pendingPolicyEvaluation.ok
      && pendingPolicyEvaluation.status === 'pending-evidence'
      && pendingPolicyEvaluation.passed === false],
    ['active policy binds exact derived source and current record IDs',
      validateBudgetPolicy(activeBudgetPolicy).ok
      && activePolicyEvaluation.ok
      && activePolicyEvaluation.status === 'passed'
      && activePolicyEvaluation.passed],
    ['active policy fails closed when a retained record is missing',
      !missingPolicyRecordEvaluation.ok
      && missingPolicyRecordEvaluation.status === 'refused'],
    ['active policy reports provisional evidence without passing',
      !provisionalPolicyEvaluation.ok
      && provisionalPolicyEvaluation.status === 'provisional'
      && !provisionalPolicyEvaluation.passed],
    ['active policy reports budget regression without passing',
      !regressedPolicyEvaluation.ok
      && regressedPolicyEvaluation.status === 'failed'
      && !regressedPolicyEvaluation.passed],
    ['policy cohorts cannot reuse baseline or current record IDs',
      !validateBudgetPolicy(duplicatePolicyCohort).ok],
    ['budget policy parser accepts only canonical unambiguous bytes',
      parseBudgetPolicy(canonicalPendingPolicy).ok
      && !duplicateKeyPolicy.ok],
    ['pending policy artifact is valid but a missing policy fails closed',
      pendingPolicyFileCheck.ok
      && pendingPolicyFileCheck.status === 'pending-evidence'
      && pendingPolicyFileCheck.passed === false
      && !missingPolicyFileCheck.ok],
    ['active policy fails closed when its portable evidence bundle is absent',
      !missingPortableEvidenceCheck.ok
      && missingPortableEvidenceCheck.status === 'refused'
      && missingPortableEvidenceCheck.passed === false],
    ['active policy routes distinct workload and execution-mode cohorts',
      validateBudgetPolicy(routedBudgetPolicy).ok
      && routedPolicyEvaluation.ok
      && routedPolicyEvaluation.evaluations.length === 2
      && routedPolicyEvaluation.evaluations.every(
        (evaluation) => evaluation.status === 'passed',
      )],
    ['budget source refuses unavailable provider, model, or engine identity',
      !unavailableSource.ok],
    ['budget evaluation refuses retained unavailable runtime identity',
      unavailableBudget.status === 'refused'],
    ['caller JSON cannot seed an enforceable budget', !untrustedSource.ok],
    ['mutation after authentication invalidates exact source replay', !mutatedSource.ok],
    ['config mutation after authentication invalidates exact source replay',
      !mutatedConfigSource.ok],
    ['intent mutation after authentication invalidates exact source replay',
      !mutatedIntentSource.ok],
    ['outcome mutation after authentication invalidates exact source replay',
      !mutatedOutcomeSource.ok],
    ['stable matching budget passes', passedBudget.status === 'passed'],
    ['budget cohort derives from named source independent of caller order',
      reversedBaselineBudget.status === 'passed'],
    ['extra decoy baseline cohort is refused', decoyBaselineBudget.status === 'refused'],
    ['current checkpoint may use a different exact revision by declared policy',
      revisedCurrentBudget.status === 'passed'],
    ['one current budget cohort cannot pool repository revisions',
      mixedRevisionCurrentBudget.status === 'refused'],
    ['stable regression fails its metric limit', failedBudget.status === 'failed'],
    ['duplicate current IDs refuse budget evaluation', duplicateCurrentBudget.status === 'refused'],
    ['current budgets reject reused source observation identities',
      reusedObservationBudget.status === 'refused'],
    ['current budgets reject reused source terminal evidence',
      reusedTerminalBudget.status === 'refused'],
    ['budget stays provisional below stable floor', provisionalBudget.status === 'provisional'],
    ['p95 budget refuses below reporting floor', refusedBudget.status === 'refused'],
    ['hostile finite magnitudes are rejected before aggregate overflow',
      !validateMeasurement(hugeNumberRecord).ok
      && !hugeBudgetSource.ok
      && !validateMeasurement(formerlyAdmittedOverflowRecord).ok
      && aggregateBoundarySummary.invalid.length === 0
      && Number.isSafeInteger(aggregateBoundaryRate?.sampleCount)
      && Number.isSafeInteger(aggregateBoundaryRate?.successCount)],
    ['wide objects stop at the graph-width bound before descriptor amplification',
      !wideObjectGraph.ok
      && wideObjectGraph.errors.includes(
        `record: exceeds ${MAX_STORE_RECORDS} own properties`,
      )
      && wideObject.descriptorReads() === 0],
    ['wide arrays with named properties stop at the graph-width bound',
      !wideNamedArrayGraph.ok
      && wideNamedArrayGraph.errors.includes(
        `record: exceeds ${MAX_STORE_RECORDS} own properties`,
      )
      && wideNamedArray.descriptorReads() === 0],
    ['raw record persists once at mode 0600', persisted.ok && !duplicate.ok
      && persistedMode === 0o600],
    ['two no-replace writers admit exactly one complete record', persisted.ok && !duplicate.ok
      && stored.ok && stored.records.length === 1],
    ['two concurrent processes admit exactly one complete record',
      concurrentStatuses.filter((status) => status === 0).length === 1
      && concurrentStatuses.filter((status) => status === 1).length === 1
      && concurrentRead.ok
      && concurrentRead.records.length === 1],
    ['concurrent temporary partial content is invisible to readers',
      stored.ok && stored.records.length === 1],
    ['failed validation leaves no final record', !invalidWrite.ok && !invalidFinalExists],
    ['UUID symlinks cannot import external mode-0600 records', !symlinkRead.ok],
    ['oversized stored records are rejected before parsing', !oversizedRead.ok],
    ['oversized stdin is rejected before JSON parsing', oversizedInput.status === 2],
    ['widened record modes are rejected rather than repaired', !widenedRead.ok],
    ['widened store modes are rejected rather than repaired', !widenedDirectoryRead.ok],
    ['missing authority with records is corruption, not an empty store',
      !missingAuthorityRead.ok && !missingAuthorityWrite.ok],
    ['an actually empty store is healthy and may initialize once',
      emptyStoreRead.ok && emptyStoreRead.records.length === 0 && emptyStoreWrite.ok],
    ['hard-link publication crash state is recovered before reading',
      recoveredPublication.ok && recoveredPublication.records.length === 1],
    ['active publish and concurrent recovery reader remain mutually excluded',
      publishReadRace.observedWindow
      && publishReadRace.writerStatus === 0
      && publishReadRace.readerStatus === 0
      && publishReadRace.readerDurationMs >= 300
      && publishReadFinal.ok
      && publishReadFinal.records.length === 2],
    ['stale PID-instance lock is replaced by exact Git-ref CAS and released',
      staleInstalled && staleRecovered.ok && staleReleased],
    ['dead-PID lock is replaced by exact Git-ref CAS and released',
      deadInstalled && deadRecovered.ok && deadReleased],
    ['zombie lock owners are recoverable while unverifiable identities fail closed',
      zombieOwnerIsDead && unverifiableOwnerStaysLive],
    ['symbolic lock refs and ref-type races never mutate their targets',
      symbolicTargetInstalled
      && directLockInstalled
      && racedExpectedOid === staleOwnerOid
      && symbolicRaceInstalled
      && symbolicReadRejected
      && symbolicUpdateRejected
      && stableSymbolicTargetPreserved
      && symbolicLockTarget === symbolicTargetRef
      && racedTargetPreserved
      && racedRefStateSafe
      && releaseTargetInstalled
      && releaseLockInstalled
      && releaseExpectedOid === deadOwnerOid
      && releaseRaceInstalled
      && racedReleaseDeleted
      && releaseTargetPreserved
      && releaseLockAbsent
      && brokenSymbolicInstalled
      && brokenSymbolicRejected
      && symbolicFixtureClean],
    ['ambient Git directory, worktree, object, and config overrides cannot redirect capture',
      hostileGitRevision === fixtureRevision()
      && hostileMeasurementDirectory === trustedMeasurementDirectory
      && hostileGitPersist.ok
      && hostileGitRead.ok
      && hostileGitRead.records.length === 1
      && readStoreLockOid() === null],
    ['invalid authenticated avoided evidence fails the store summary',
      !invalidAvoidedSummary.ok
      && invalidAvoidedSummary.summary.unitCohorts.length === 0],
    ['persistence rejects a caller-spoofed revision', !spoofedRevision.ok],
    ['legacy import remains unavailable without separate authenticated provenance',
      !legacyImport.ok],
    ['future caller timestamps are rejected by validation', !validateMeasurement(futureRecord).ok],
    ['persisted capture binds live HEAD and labels trust sources precisely',
      stored.records[0]?.revision === fixtureRevision()
      && stored.records[0]?.provenance.capture.revisionSource === 'live-git-head'
      && stored.records[0]?.provenance.capture.timeSource === 'tool-clock'
      && stored.records[0]?.provenance.capture.checkpointSource === 'operator-declared'
      && stored.records[0]?.provenance.capture.observationSource === 'run-record-declared'],
  ];
  let passed = 0;
  for (const [name, ok] of cases) {
    if (!ok) console.error(`FAIL ${name}`);
    else passed += 1;
  }
  console.log(
    passed === cases.length
      ? `self-test OK (${passed} cases)`
      : `self-test FAILED (${passed}/${cases.length})`,
  );
  return passed === cases.length;
}

function parseArgs(args) {
  if (args.length === 1 && args[0] === '--self-test') return { mode: 'self-test' };
  if (args.length === 0) return { mode: 'summarize' };
  if (args.length === 1 && args[0] === '--record') return { mode: 'record' };
  if (args.length === 1 && args[0] === '--capture-event') {
    return { mode: 'capture-event' };
  }
  if (args.length === 1 && args[0] === '--run-operation') {
    return { mode: 'run-operation' };
  }
  if (args.length === 1 && args[0] === '--finalize-events') {
    return { mode: 'finalize-events' };
  }
  if (args.length === 1 && args[0] === '--export-evidence-bundle') {
    return { mode: 'export-evidence-bundle' };
  }
  if (args.length === 2 && args[0] === '--check-budget-policy') {
    return { mode: 'check-budget-policy', path: args[1] };
  }
  if (args.length === 1 && args[0] === '--summarize-store') {
    return { mode: 'summarize-store' };
  }
  if (args.length === 2 && args[0] === '--compare') {
    return { mode: 'compare', checkpoint: args[1] };
  }
  if (args.length === 1 && args[0] === '--validate-budget') {
    return { mode: 'validate-budget' };
  }
  if (args.length === 1 && args[0] === '--budget-source') {
    return { mode: 'budget-source' };
  }
  if (args.length === 1 && args[0] === '--evaluate-budget') {
    return { mode: 'evaluate-budget' };
  }
  return {
    mode: null,
    error:
      'expected --capture-event, --run-operation, --finalize-events, '
      + '--check-budget-policy <path>, '
      + '--export-evidence-bundle, '
      + '--summarize-store, --compare <checkpoint>, --budget-source, --validate-budget, '
      + '--evaluate-budget, --self-test, or no arguments (--record is refused)',
  };
}

function measurementDirectory() {
  const gitPath = gitExec(
    ['rev-parse', '--git-path', 'autoloop/measurements/v1'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
  if (!gitPath) throw new Error('git returned an empty measurement path');
  return resolve(GIT_CONTEXT, gitPath);
}

function readJsonInput() {
  try {
    const chunks = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_INPUT_BYTES + 1 - total));
      const count = readSync(0, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > MAX_INPUT_BYTES) {
        return { ok: false, error: `JSON input exceeds ${MAX_INPUT_BYTES} bytes` };
      }
      chunks.push(chunk.subarray(0, count));
    }
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch (error) {
    return { ok: false, error: `invalid JSON input: ${error.message}` };
  }
}

function trustedRecordsById(input, directory, field = 'recordIds') {
  if (
    !exactObject([], 'selection', input, [field])
    || !denseArray([], `selection.${field}`, input?.[field], 1, MAX_STORE_RECORDS)
  ) {
    return { ok: false, errors: [`${field}: expected a non-empty bounded ID array`] };
  }
  const ids = input[field];
  if (new Set(ids).size !== ids.length || ids.some((recordId) => !UUID_RE.test(recordId ?? ''))) {
    return { ok: false, errors: [`${field}: expected unique UUID v4 values`] };
  }
  const stored = readMeasurements(directory);
  if (!stored.ok) return stored;
  const byId = new Map(stored.records.map((recordValue) => [recordValue.recordId, recordValue]));
  const missing = ids.filter((recordId) => !byId.has(recordId));
  if (missing.length > 0) return { ok: false, errors: [`missing authenticated records: ${missing.join(', ')}`] };
  return { ok: true, records: ids.map((recordId) => byId.get(recordId)) };
}

function writeResult(result, success = result.ok !== false) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(success ? 0 : 1);
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(`measurement-contract: ${parsed.error}`);
    process.exit(2);
  }
  if (parsed.mode === 'self-test') process.exit(await selfTest() ? 0 : 1);
  if (parsed.mode === 'summarize-store') {
    let result;
    try {
      result = summarizeMeasurementStore(measurementDirectory());
    } catch (error) {
      console.error(`measurement-contract: cannot resolve Git measurement storage: ${error.message}`);
      process.exit(1);
    }
    delete result.records;
    writeResult(result, result.ok);
  }
  if (parsed.mode === 'check-budget-policy') {
    const result = checkBudgetPolicyAt(parsed.path);
    writeResult(result, result.ok);
  }
  if (parsed.mode === 'record') {
    writeResult({
      ok: false,
      errors: [
        'caller-composed aggregate records are refused; capture authenticated raw events and finalize them',
      ],
    }, false);
  }
  const input = readJsonInput();
  if (!input.ok) {
    console.error(`measurement-contract: ${input.error}`);
    process.exit(2);
  }
  if (parsed.mode === 'capture-event') {
    let directory;
    try {
      directory = measurementDirectory();
    } catch (error) {
      console.error(`measurement-contract: cannot resolve Git measurement storage: ${error.message}`);
      process.exit(1);
    }
    writeResult(captureTypedMeasurementEvent(input.value, directory));
  }
  if (parsed.mode === 'run-operation') {
    let directory;
    try {
      directory = measurementDirectory();
    } catch (error) {
      console.error(`measurement-contract: cannot resolve Git measurement storage: ${error.message}`);
      process.exit(1);
    }
    writeResult(runMeasuredOperation(input.value, directory));
  }
  if (parsed.mode === 'finalize-events') {
    let directory;
    try {
      directory = measurementDirectory();
    } catch (error) {
      console.error(`measurement-contract: cannot resolve Git measurement storage: ${error.message}`);
      process.exit(1);
    }
    writeResult(finalizeMeasurementRun(input.value, directory));
  }
  if (parsed.mode === 'export-evidence-bundle') {
    if (
      !exactObject([], 'selection', input.value, ['recordIds'])
      || !Array.isArray(input.value.recordIds)
    ) {
      writeResult({ ok: false, errors: ['recordIds: expected an ID array'] }, false);
    }
    let directory;
    try {
      directory = measurementDirectory();
    } catch (error) {
      writeResult({ ok: false, errors: [error.message] }, false);
    }
    const exported = exportMeasurementEvidenceBundle(
      input.value.recordIds,
      directory,
    );
    if (!exported.ok) writeResult(exported, false);
    process.stderr.write(`measurement evidence sha256 ${exported.sha256}\n`);
    process.stdout.write(exported.source);
    process.exit(0);
  }
  if (parsed.mode === 'compare') {
    const records = Array.isArray(input.value) ? input.value : [input.value];
    writeResult(compareCheckpoints(records, parsed.checkpoint));
  }
  if (parsed.mode === 'validate-budget') {
    writeResult(validateBudgetSpec(input.value));
  }
  if (parsed.mode === 'budget-source') {
    let directory;
    try {
      directory = measurementDirectory();
    } catch (error) {
      writeResult({ ok: false, errors: [error.message] }, false);
    }
    const selection = trustedRecordsById(input.value, directory);
    if (!selection.ok) writeResult(selection, false);
    writeResult(buildBudgetSource(selection.records));
  }
  if (parsed.mode === 'evaluate-budget') {
    if (
      !exactObject(
        [],
        'evaluation',
        input.value,
        ['budget', 'baselineRecordIds', 'currentRecordIds'],
      )
    ) {
      writeResult({ ok: false, status: 'refused', errors: ['invalid evaluation input'] }, false);
    }
    let directory;
    try {
      directory = measurementDirectory();
    } catch (error) {
      writeResult({ ok: false, status: 'refused', errors: [error.message] }, false);
    }
    const baseline = trustedRecordsById(
      { recordIds: input.value.baselineRecordIds },
      directory,
    );
    const current = trustedRecordsById(
      { recordIds: input.value.currentRecordIds },
      directory,
    );
    if (!baseline.ok || !current.ok) {
      writeResult({
        ok: false,
        status: 'refused',
        errors: [...(baseline.errors ?? []), ...(current.errors ?? [])],
      }, false);
    }
    writeResult(evaluateBudget(
      input.value.budget,
      baseline.records,
      current.records,
    ));
  }
  const records = Array.isArray(input.value) ? input.value : [input.value];
  const summary = summarizeMeasurements(records);
  writeResult({ ok: summary.invalid.length === 0, summary });
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
  try {
    await main();
  } catch (error) {
    const detail = process.argv.includes('--self-test') ? error.stack : error.message;
    console.error(`measurement-contract: ${detail}`);
    process.exit(1);
  }
}
