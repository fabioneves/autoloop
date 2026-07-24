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
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MEASUREMENT_VERSION = 1;
export const BUDGET_VERSION = 1;

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
const ROLES = new Set(['writer', 'reviewer', 'orchestrator']);
const CHECKPOINTS = new Set(['legacy-workflow', 'safe-system', 'post-optimization']);
const FLOWS = new Set(['dev', 'pitcrew']);
const MERGE_POLICIES = new Set(['manual', 'ratified', 'auto']);
const BASE_STRATEGIES = new Set(['manual', 'direct-strict', 'merge-queue']);
const INTENT_SOURCES = new Set(['invocation', 'relaunch', 'orphan-recovery']);
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

const RECORD_KEYS = [
  'version',
  'recordId',
  'capturedAt',
  'revision',
  'workload',
  'checkpoint',
  'activeHost',
  'selector',
  'requestedEngine',
  'requestedRoute',
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
const OBSERVATION_KEYS = ['runId', 'unitId', 'terminalEvidenceFingerprint'];
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
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_STORE_RECORDS = 10_000;
const MAX_DATA_DEPTH = 32;
const MAX_DATA_NODES = 100_000;
const STORE_KEY_FILE = '.measurement-auth-key';
const STORE_LOCK_REF = 'refs/autoloop/measurement-store-lock';
const STORE_LOCK_TIMEOUT_MS = 15_000;
const TRUSTED_RECORDS = new WeakMap();
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(descriptors).every(
    (key) => typeof key === 'string' && !descriptors[key].get && !descriptors[key].set,
  );
}

function validateDataGraph(value) {
  const errors = [];
  const stack = [{ value, depth: 0, path: 'record' }];
  const seen = new Set();
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > MAX_DATA_NODES) {
      errors.push(`record: exceeds ${MAX_DATA_NODES} data nodes`);
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
    if (!Array.isArray(current.value) && !plainObject(current.value)) {
      errors.push(`${current.path}: expected plain JSON data`);
      continue;
    }
    if (Array.isArray(current.value) && current.value.length > MAX_DATA_NODES) {
      errors.push(`${current.path}: array exceeds ${MAX_DATA_NODES} entries`);
      continue;
    }
    let descriptors;
    try {
      descriptors = Object.getOwnPropertyDescriptors(current.value);
    } catch {
      errors.push(`${current.path}: property inspection failed`);
      continue;
    }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (key === 'length') continue;
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
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function integer(value) {
  return Number.isInteger(value) && value >= 0;
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

function validateObservation(errors, path, value, type) {
  if (!plainObject(value) || !['observed', 'unavailable'].includes(value.status)) {
    errors.push(`${path}: expected a typed observed or unavailable value`);
    return;
  }
  if (value.status === 'observed') {
    if (!exactObject(errors, path, value, ['status', 'value'])) return;
    if (type === 'string') requireString(errors, `${path}.value`, value.value, 200);
    if (type === 'integer') requireNumber(errors, `${path}.value`, value.value, true);
    if (type === 'number') requireNumber(errors, `${path}.value`, value.value);
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

function validateTelemetry(errors, path, value, segment = false) {
  const keys = segment ? SEGMENT_TELEMETRY_KEYS : UNIT_TELEMETRY_KEYS;
  if (!exactObject(errors, path, value, keys)) return;
  if (segment) {
    for (const key of ['provider', 'model', 'engine']) {
      validateObservation(errors, `${path}.${key}`, value[key], 'string');
    }
  }
  for (const key of ['promptTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens']) {
    validateObservation(errors, `${path}.${key}`, value[key], 'integer');
  }
  validateObservation(errors, `${path}.contextBytes`, value.contextBytes, 'integer');
  validateObservation(errors, `${path}.costUsd`, value.costUsd, 'number');
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
    return recordValue.lane === 'full' ? recordValue.requestedRoute : native;
  }
  if (segment.stage === 'implementation') {
    return recordValue.lane === 'docs' ? native : recordValue.requestedRoute;
  }
  if (segment.stage === 'code-review') {
    if (segment.round >= 2 || recordValue.lane !== 'full') return native;
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
  } else if (segment.degradation !== null) {
    errors.push(`${path}.degradation: forbidden when the requested route was used`);
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
  validateTelemetry(errors, 'unit.telemetry', value.telemetry);
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
  const dispatchStages = new Set([
    'plan-review',
    'implementation',
    'code-review',
    'judgment-review',
  ]);
  const dispatchSegments = segments.filter(
    (segment) => dispatchStages.has(segment.stage),
  );
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
  const selectionIndex = segments.findIndex((segment) => segment?.stage === 'selection');
  if (selectionIndex >= 0 && finiteNumber(value.timing?.timeToFirstSelectionMs)) {
    const throughSelection = segments.slice(0, selectionIndex + 1).reduce(
      (sum, segment) => sum + segment.timing.totalMs,
      0,
    );
    if (value.timing.timeToFirstSelectionMs !== throughSelection) {
      errors.push(
        `unit.timing.timeToFirstSelectionMs: expected ${throughSelection} through selection`,
      );
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
    } else if (!allObserved && unitValue !== null) {
      errors.push(`unit.telemetry.${key}: cannot be observed when a segment is unavailable`);
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
  requireEnum(errors, 'activeHost', value.activeHost, HOSTS);
  requireEnum(errors, 'selector', value.selector, SELECTORS);
  requireEnum(errors, 'requestedEngine', value.requestedEngine, HOSTS);
  requireEnum(errors, 'requestedRoute', value.requestedRoute, ROUTES);
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
    if (!HASH_RE.test(value.observation.terminalEvidenceFingerprint ?? '')) {
      errors.push('observation.terminalEvidenceFingerprint: expected sha256');
    }
  }
  if (value.provenance !== undefined) {
    if (exactObject(errors, 'provenance', value.provenance, PROVENANCE_KEYS)) {
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
        if (value.provenance.capture.observationSource !== 'run-record-declared') {
          errors.push('provenance.capture.observationSource: expected run-record-declared');
        }
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
    ? (sorted[middle - 1] + sorted[middle]) / 2
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
  return value === null ? null : `${value.code}:${value.reason}`;
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
    actualRoutes: actualRoutes(recordValue),
    lane: recordValue.lane,
    mergePolicy: recordValue.mergePolicy,
    baseFreshnessStrategy: recordValue.baseFreshnessStrategy,
  };
}

const COHORT_ALLOWED_VARIATION = Object.freeze({
  summarize: [],
  compare: ['revision', 'checkpoint', 'recordId', 'capturedAt', 'terminalOutcome'],
  budgetSource: ['recordId', 'capturedAt', 'terminalOutcome'],
  budgetCurrent: ['revision', 'checkpoint', 'recordId', 'capturedAt', 'terminalOutcome'],
  control: [
    'revision',
    'checkpoint',
    'recordId',
    'capturedAt',
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

function strictCohortIdentity(recordValue, operation = 'summarize') {
  const full = {
    revision: recordValue.revision,
    workload: recordValue.workload,
    checkpoint: recordValue.checkpoint,
    ...recordMode(recordValue),
    intent: recordValue.intent,
    configFingerprint: recordValue.configFingerprint,
    capabilityFingerprint: recordValue.capabilityFingerprint,
    outageFingerprint: recordValue.outageFingerprint,
    outageTransition: recordValue.outageTransition,
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
  }));
  invalid.push(...uniqueness.errors.map((error) => ({ index: null, errors: [error] })));
  return { invalid, unitCohorts, segmentCohorts };
}

function comparisonKey(recordValue) {
  return strictCohortIdentity(recordValue, 'compare');
}

function aggregateUnitRecords(records) {
  return {
    sampleCount: records.length,
    metrics: collectMetrics(records, UNIT_NUMERIC_METRICS, 'unit.timing'),
    rates: collectRates(records),
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
    if (before.length === 0 || after.length === 0) {
      unmatched.push({
        cohort,
        legacyCount: before.length,
        afterCount: after.length,
      });
      continue;
    }
    const beforeSummary = aggregateUnitRecords(before);
    const afterSummary = aggregateUnitRecords(after);
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
      errors: ['source requires unique authenticated valid safe-system records', ...recordSet.errors],
    };
  }
  if (records.some((recordValue) => !isTrustedRecord(recordValue))) {
    return { ok: false, errors: ['source records must come from an authenticated local store'] };
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
  return { ok: true, workload: first.workload, mode, source };
}

function validateMode(errors, value) {
  if (!exactObject(errors, 'mode', value, MODE_KEYS)) return;
  requireEnum(errors, 'mode.activeHost', value.activeHost, HOSTS);
  requireEnum(errors, 'mode.selector', value.selector, SELECTORS);
  requireEnum(errors, 'mode.requestedEngine', value.requestedEngine, HOSTS);
  requireEnum(errors, 'mode.requestedRoute', value.requestedRoute, ROUTES);
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
      (recordValue) => !isTrustedRecord(recordValue),
    )
  ) {
    return {
      ok: false,
      status: 'refused',
      errors: [
        'budget evaluation requires unique authenticated store records',
        ...baselineSet.errors,
        ...currentSet.errors,
      ],
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
  return { ok: status === 'passed', status, metrics: results };
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

function processIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
    if (fields[19]) return `proc:${fields[19]}`;
  } catch {}
  try {
    const started = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    }).trim();
    return started ? `ps:${started}` : null;
  } catch {
    return null;
  }
}

function processOwnerAlive(owner) {
  if (!plainObject(owner) || !Number.isInteger(owner.pid) || owner.pid < 1) return null;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    return null;
  }
  const identity = processIdentity(owner.pid);
  if (owner.processIdentity !== null && identity !== null) {
    return owner.processIdentity === identity;
  }
  return true;
}

function readStoreLockOid() {
  const result = gitSpawn(
    ['rev-parse', '--verify', '--quiet', STORE_LOCK_REF],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  if (result.status === 1) return null;
  if (result.status !== 0) throw new Error('cannot inspect measurement store lock');
  const oid = result.stdout.trim();
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

function updateStoreLock(newOid, expectedOid) {
  const args = newOid === null
    ? ['update-ref', '-d', STORE_LOCK_REF, expectedOid]
    : ['update-ref', STORE_LOCK_REF, newOid, expectedOid];
  return gitSpawn(args, {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: 2_000,
  }).status === 0;
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
  }))).digest('hex');
}

function authenticateRecord(recordValue, authority, capturedAt) {
  const authenticated = {
    ...recordContent(recordValue),
    provenance: {
      kind: 'tool-authenticated',
      storeId: authority.storeId,
      authenticatedAt: capturedAt,
      contentFingerprint: recordContentFingerprint(recordValue),
      observationFingerprint: observationFingerprint(recordValue),
      capture: {
        revisionSource: 'live-git-head',
        timeSource: 'tool-clock',
        checkpointSource: 'operator-declared',
        observationSource: 'run-record-declared',
      },
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

export function persistMeasurement(recordValue, directory) {
  const raw = recordContent(recordValue);
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
  const capturedAt = new Date().toISOString();
  raw.capturedAt = capturedAt;
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
      const authenticated = authenticateRecord(raw, authority, capturedAt);
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
    });
  } catch (error) {
    return { ok: false, errors: [`record persistence failed: ${error.message}`] };
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
        trustRecord(value);
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
}) {
  return {
    id,
    stage,
    round,
    role: expectedRole(stage),
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
    activeHost: 'claude',
    selector: 'codex',
    requestedEngine: 'codex',
    requestedRoute: external,
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
  };
}

function fixtureRecords(count, checkpoint, totalMs = 100) {
  return Array.from({ length: count }, (_, index) => fixtureRecord(totalMs + index, {
    recordId: `123e4567-e89b-42d3-a456-${String(426614174000 + index).padStart(12, '0')}`,
    checkpoint,
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
          observationSource: 'run-record-declared',
        },
        mac: createHash('sha256').update(`fixture-${index}`).digest('hex'),
      },
    };
    trustRecord(authenticated);
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

async function selfTest() {
  const valid = fixtureRecord();
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
  const unknownNested = structuredClone(valid);
  unknownNested.segments[0].telemetry.retiredTokens = observed(1);
  const invalidLaneRoute = structuredClone(valid);
  invalidLaneRoute.lane = 'docs';
  const sparse = structuredClone(valid);
  sparse.segments = new Array(2);
  sparse.segments[0] = valid.segments[0];
  const hundred = fixtureRecords(100, 'safe-system');
  hundred[99].unit.telemetry.reasoningTokens = unavailable('one unavailable value');
  const summary = summarizeMeasurements(hundred);
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
  const tempDirectory = join(tmpdir(), `autoloop-measurement-${randomUUID()}`);
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
  const wrongControl = fixtureMatchedControl({}, { configFingerprint: 'f'.repeat(64) });
  const wrongControlSummary = summarizeMeasurements([wrongControl.subject, wrongControl.control]);
  const inconsistentEvidence = fixtureMatchedControl();
  inconsistentEvidence.subject.unit.outcomes.avoidedRework.avoidedTime.evidence.counterfactualValue += 1;
  const inconsistentEvidenceSummary = summarizeMeasurements([
    inconsistentEvidence.subject,
    inconsistentEvidence.control,
  ]);
  const externalDirectory = join(tmpdir(), `autoloop-measurement-external-${randomUUID()}`);
  mkdirSync(externalDirectory, { mode: 0o700 });
  const externalPath = join(externalDirectory, `${valid.recordId}.json`);
  writeFileSync(externalPath, `${JSON.stringify(valid)}\n`, { mode: 0o600 });
  const symlinkStore = join(tmpdir(), `autoloop-measurement-symlink-${randomUUID()}`);
  persistMeasurement({ ...valid, recordId: '823e4567-e89b-42d3-a456-426614174000' }, symlinkStore);
  symlinkSync(externalPath, join(symlinkStore, `${valid.recordId}.json`));
  const symlinkRead = readMeasurements(symlinkStore);
  const oversizedStore = join(tmpdir(), `autoloop-measurement-oversized-${randomUUID()}`);
  persistMeasurement({ ...valid, recordId: '923e4567-e89b-42d3-a456-426614174000' }, oversizedStore);
  const oversizedId = 'a23e4567-e89b-42d3-a456-426614174000';
  writeFileSync(join(oversizedStore, `${oversizedId}.json`), 'x'.repeat(MAX_RECORD_BYTES + 1), {
    mode: 0o600,
  });
  const oversizedRead = readMeasurements(oversizedStore);
  const widenedStore = join(tmpdir(), `autoloop-measurement-mode-${randomUUID()}`);
  const widenedPersist = persistMeasurement(valid, widenedStore);
  const widenedDescriptor = openSync(widenedPersist.path, constants.O_RDONLY);
  fchmodSync(widenedDescriptor, 0o644);
  closeSync(widenedDescriptor);
  const widenedRead = readMeasurements(widenedStore);
  const widenedDirectoryStore = join(
    tmpdir(),
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
    tmpdir(),
    `autoloop-measurement-missing-authority-${randomUUID()}`,
  );
  const missingAuthorityInitial = persistMeasurement(valid, missingAuthorityStore);
  unlinkSync(join(missingAuthorityStore, STORE_KEY_FILE));
  const missingAuthorityRead = readMeasurements(missingAuthorityStore);
  const missingAuthorityWrite = persistMeasurement({
    ...valid,
    recordId: 'ab3e4567-e89b-42d3-a456-426614174000',
  }, missingAuthorityStore);
  const emptyStore = join(tmpdir(), `autoloop-measurement-empty-${randomUUID()}`);
  mkdirSync(emptyStore, { mode: 0o700 });
  const emptyStoreRead = readMeasurements(emptyStore);
  const emptyStoreWrite = persistMeasurement(valid, emptyStore);
  const publicationStore = join(tmpdir(), `autoloop-measurement-publication-${randomUUID()}`);
  const publicationPersist = persistMeasurement(valid, publicationStore);
  linkSync(
    publicationPersist.path,
    join(publicationStore, `.tmp-${randomUUID()}`),
  );
  const recoveredPublication = readMeasurements(publicationStore);
  const invalidAvoidedStore = join(
    tmpdir(),
    `autoloop-measurement-invalid-avoided-${randomUUID()}`,
  );
  const invalidAvoided = structuredClone(valid);
  invalidAvoided.recordId = 'ac3e4567-e89b-42d3-a456-426614174000';
  invalidAvoided.observation = {
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
  }, join(tmpdir(), `autoloop-measurement-spoof-${randomUUID()}`));
  const legacyImport = persistMeasurement({
    ...valid,
    checkpoint: 'legacy-workflow',
    recordId: 'af3e4567-e89b-42d3-a456-426614174000',
  }, join(tmpdir(), `autoloop-measurement-legacy-${randomUUID()}`));
  const futureRecord = structuredClone(valid);
  futureRecord.capturedAt = '2999-01-01T00:00:00.000Z';
  const semanticClones = Array.from({ length: 100 }, (_, index) => ({
    ...structuredClone(valid),
    recordId: `b13e4567-e89b-42d3-a456-${String(426614174000 + index).padStart(12, '0')}`,
    observation: {
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
    tmpdir(),
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
  const hostileGitStore = join(
    tmpdir(),
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
  const concurrentStore = join(tmpdir(), `autoloop-measurement-race-${randomUUID()}`);
  const concurrentStatuses = await concurrentPersist(valid, concurrentStore);
  const concurrentRead = readMeasurements(concurrentStore);
  const invalidWriteDirectory = join(tmpdir(), `autoloop-measurement-invalid-${randomUUID()}`);
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
  const cases = [
    ['mixed-route unit is valid', validateMeasurement(valid).ok],
    ['unknown and retired top-level keys are rejected', !validateMeasurement(unknown).ok],
    [
      'legacyProfile is the only admitted retired key',
      validateMeasurement({ ...valid, legacyProfile: 'codex' }).ok,
    ],
    ['unsupported host-selector pair is rejected', !validateMeasurement(impossible).ok],
    ['adapter must equal the actual closed-catalog route', !validateMeasurement(invalidAdapter).ok],
    ['unknown nested telemetry keys are rejected', !validateMeasurement(unknownNested).ok],
    ['stage and lane routing is enforced', !validateMeasurement(invalidLaneRoute).ok],
    ['sparse segment arrays are rejected', !validateMeasurement(sparse).ok],
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
    ['outcome rates retain their own sample count', summary.unitCohorts[0]
      ?.rates['review.acceptedRebut']?.sampleCount === 100],
    ['manual legacy and safe checkpoints compare by observed route set',
      comparison.ok && comparison.matches.length === 1],
    ['budget source is exact safe-system cohort evidence', source.ok
      && validateBudgetSpec(budget).ok],
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
    ['stable regression fails its metric limit', failedBudget.status === 'failed'],
    ['duplicate current IDs refuse budget evaluation', duplicateCurrentBudget.status === 'refused'],
    ['current budgets reject reused source observation identities',
      reusedObservationBudget.status === 'refused'],
    ['current budgets reject reused source terminal evidence',
      reusedTerminalBudget.status === 'refused'],
    ['budget stays provisional below stable floor', provisionalBudget.status === 'provisional'],
    ['p95 budget refuses below reporting floor', refusedBudget.status === 'refused'],
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
      'expected --record, --summarize-store, --compare <checkpoint>, '
      + '--budget-source, --validate-budget, --evaluate-budget, --self-test, or no arguments',
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
  const input = readJsonInput();
  if (!input.ok) {
    console.error(`measurement-contract: ${input.error}`);
    process.exit(2);
  }
  if (parsed.mode === 'record') {
    let directory;
    try {
      directory = measurementDirectory();
    } catch (error) {
      console.error(`measurement-contract: cannot resolve Git measurement storage: ${error.message}`);
      process.exit(1);
    }
    writeResult(persistMeasurement(input.value, directory));
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
    console.error(`measurement-contract: ${error.message}`);
    process.exit(1);
  }
}
