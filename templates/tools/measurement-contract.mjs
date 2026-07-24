#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
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
  'plan-review',
  'implementation',
  'code-review',
  'judgment-review',
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
];
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
  'gate',
  'recovery',
  'overlap',
  'laneEffectiveness',
  'avoidedRework',
];
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
  'value',
  'unit',
  'method',
  'evidenceFingerprint',
  'controlRecordIds',
];
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
  'recordIds',
  'evidence',
];
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

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(descriptors).every(
    (key) => typeof key === 'string' && !descriptors[key].get && !descriptors[key].set,
  );
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
  if (value.length < minimum || value.length > maximum) {
    errors.push(`${path}: expected ${minimum}..${maximum} entries`);
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
    && components.reduce((sum, key) => sum + value[key], 0) > value.totalMs
  ) {
    errors.push(`${path}: active and wait components exceed totalMs`);
  }
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
  if (['judgment-review', 'gate', 'delivery'].includes(segment.stage)) return native;
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
  }
}

function validateAvoidedClaim(errors, path, value, requiredUnit) {
  if (value === null) return;
  if (!exactObject(errors, path, value, AVOIDED_CLAIM_KEYS)) return;
  requireNumber(errors, `${path}.value`, value.value);
  requireEnum(errors, `${path}.unit`, value.unit, AVOIDED_UNITS);
  if (value.unit !== requiredUnit) errors.push(`${path}.unit: expected ${requiredUnit}`);
  requireEnum(errors, `${path}.method`, value.method, AVOIDED_METHODS);
  if (!HASH_RE.test(value.evidenceFingerprint ?? '')) {
    errors.push(`${path}.evidenceFingerprint: expected sha256`);
  }
  if (denseArray(errors, `${path}.controlRecordIds`, value.controlRecordIds, 0, 100)) {
    const seen = new Set();
    for (const [index, recordId] of value.controlRecordIds.entries()) {
      if (!UUID_RE.test(recordId ?? '')) {
        errors.push(`${path}.controlRecordIds[${index}]: expected a lowercase UUID v4`);
      }
      if (seen.has(recordId)) errors.push(`${path}.controlRecordIds: duplicate ${recordId}`);
      seen.add(recordId);
    }
    if (value.method === 'matched-control' && value.controlRecordIds.length === 0) {
      errors.push(`${path}.controlRecordIds: matched-control requires at least one record`);
    }
  }
}

function validateOutcomes(errors, value) {
  if (!exactObject(errors, 'unit.outcomes', value, OUTCOME_KEYS)) return;
  if (exactObject(errors, 'unit.outcomes.gate', value.gate, GATE_KEYS)) {
    requireEnum(errors, 'unit.outcomes.gate.result', value.gate.result, GATE_RESULTS);
    if (typeof value.gate.localGreenCiRed !== 'boolean') {
      errors.push('unit.outcomes.gate.localGreenCiRed: expected boolean');
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
  const dispatchSegments = segments.filter(
    (segment) => !['gate', 'delivery'].includes(segment.stage),
  ).length;
  if (integer(value.dispatch?.count) && value.dispatch.count !== dispatchSegments) {
    errors.push(`unit.dispatch.count: expected ${dispatchSegments} from segments`);
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
    if (unitValue === null || segmentValues.some((candidate) => candidate === null)) continue;
    const sum = segmentValues.reduce((total, candidate) => total + candidate, 0);
    const tolerance = key === 'costUsd' ? 1e-9 : 0;
    if (Math.abs(unitValue - sum) > tolerance) {
      errors.push(`unit.telemetry.${key}: must equal the observed segment sum`);
    }
  }
}

export function validateMeasurement(value) {
  const errors = [];
  if (!exactObject(errors, 'record', value, RECORD_KEYS, ['legacyProfile'])) {
    return { ok: false, errors };
  }
  if (value.version !== MEASUREMENT_VERSION) {
    errors.push(`version: expected ${MEASUREMENT_VERSION}`);
  }
  if (!UUID_RE.test(value.recordId ?? '')) errors.push('recordId: expected a lowercase UUID v4');
  if (!canonicalTimestamp(value.capturedAt)) {
    errors.push('capturedAt: expected a canonical UTC timestamp');
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

function unitCohort(recordValue) {
  return {
    revision: recordValue.revision,
    workload: recordValue.workload,
    checkpoint: recordValue.checkpoint,
    ...recordMode(recordValue),
    intent: recordValue.intent,
    configFingerprint: recordValue.configFingerprint,
    capabilityFingerprint: recordValue.capabilityFingerprint,
    outageFingerprint: recordValue.outageFingerprint,
    outageTransition: recordValue.outageTransition,
    avoidedCostMethods: {
      idleWait: recordValue.unit.outcomes.overlap.avoidedIdleWait?.method ?? null,
      engineTime:
        recordValue.unit.outcomes.laneEffectiveness.avoidedEngineTime?.method ?? null,
      reworkTime: recordValue.unit.outcomes.avoidedRework.avoidedTime?.method ?? null,
    },
  };
}

function segmentCohort(recordValue, segment) {
  return {
    ...unitCohort(recordValue),
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
  const invalid = [];
  const valid = [];
  records.forEach((recordValue, index) => {
    const result = validateMeasurement(recordValue);
    if (result.ok) valid.push(recordValue);
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
  return { invalid, unitCohorts, segmentCohorts };
}

function comparisonKey(recordValue) {
  return {
    workload: recordValue.workload,
    actualRoutes: actualRoutes(recordValue),
    lane: recordValue.lane,
    baseFreshnessStrategy: recordValue.baseFreshnessStrategy,
    mergePolicy: recordValue.mergePolicy,
  };
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
  const invalid = records
    .map((recordValue, index) => ({ index, result: validateMeasurement(recordValue) }))
    .filter(({ result }) => !result.ok);
  if (invalid.length > 0) {
    return {
      ok: false,
      errors: invalid.map(({ index, result }) => `${index}: ${result.errors.join('; ')}`),
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
    recordIds: source.recordIds,
    evidence: source.evidence,
  });
}

export function buildBudgetSource(records) {
  const validations = records.map(validateMeasurement);
  if (
    records.length === 0
    || validations.some((result) => !result.ok)
    || records.some((recordValue) => recordValue.checkpoint !== 'safe-system')
  ) {
    return { ok: false, errors: ['source requires valid safe-system records'] };
  }
  const first = records[0];
  const mode = recordMode(first);
  if (
    records.some(
      (recordValue) =>
        recordValue.workload !== first.workload
        || recordValue.revision !== first.revision
        || !sameValue(recordMode(recordValue), mode),
    )
  ) {
    return { ok: false, errors: ['source records must share workload, revision, and mode'] };
  }
  const recordIds = records.map((recordValue) => recordValue.recordId).sort();
  if (new Set(recordIds).size !== recordIds.length) {
    return { ok: false, errors: ['source record IDs must be unique'] };
  }
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
    recordIds,
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
    if (denseArray(errors, 'budget.source.recordIds', value.source.recordIds, 1, 10_000)) {
      const sorted = [...value.source.recordIds].sort();
      if (new Set(value.source.recordIds).size !== value.source.recordIds.length) {
        errors.push('budget.source.recordIds: IDs must be unique');
      }
      if (!sameValue(sorted, value.source.recordIds)) {
        errors.push('budget.source.recordIds: IDs must be sorted');
      }
      value.source.recordIds.forEach((recordId, index) => {
        if (!UUID_RE.test(recordId ?? '')) {
          errors.push(`budget.source.recordIds[${index}]: expected UUID v4`);
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
          && Array.isArray(value.source.recordIds)
          && evidence.sampleCount > value.source.recordIds.length
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
  const selected = records.filter((recordValue) => source.recordIds.includes(recordValue.recordId));
  if (selected.length !== source.recordIds.length) return false;
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
  if (
    !Array.isArray(baselineRecords)
    || !Array.isArray(currentRecords)
    || baselineRecords.some((recordValue) => !validateMeasurement(recordValue).ok)
    || currentRecords.some((recordValue) => !validateMeasurement(recordValue).ok)
  ) {
    return {
      ok: false,
      status: 'refused',
      errors: ['budget evaluation requires only valid measurement records'],
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
    || currentRecords.some((recordValue) => spec.source.recordIds.includes(recordValue.recordId))
  ) {
    return {
      ok: false,
      status: 'refused',
      errors: ['current records must be a disjoint matching post-optimization cohort'],
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

function ensureMeasurementDirectory(directory) {
  const target = resolve(directory);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const info = lstatSync(target);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('measurement store must be a real directory');
  }
  chmodSync(target, 0o700);
  return target;
}

export function persistMeasurement(recordValue, directory) {
  const validation = validateMeasurement(recordValue);
  if (!validation.ok) return { ok: false, errors: validation.errors };
  let targetDirectory;
  try {
    targetDirectory = ensureMeasurementDirectory(directory);
  } catch (error) {
    return { ok: false, errors: [`record persistence failed: ${error.message}`] };
  }
  const path = join(targetDirectory, `${recordValue.recordId}.json`);
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(recordValue)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    return { ok: true, path };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    return { ok: false, errors: [`record persistence failed: ${error.message}`] };
  }
}

export function readMeasurements(directory) {
  const records = [];
  const errors = [];
  let names;
  const target = resolve(directory);
  try {
    const info = lstatSync(target);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      return { ok: false, records, errors: ['measurement store must be a real directory'] };
    }
    names = readdirSync(target).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, records, errors };
    return { ok: false, records, errors: [`measurement store read failed: ${error.message}`] };
  }
  for (const name of names) {
    if (!UUID_RE.test(name.replace(/\.json$/u, ''))) {
      errors.push(`${name}: filename is not a measurement UUID`);
      continue;
    }
    try {
      if ((statSync(join(target, name)).mode & 0o777) !== 0o600) {
        errors.push(`${name}: expected mode 0600`);
        continue;
      }
      const value = JSON.parse(readFileSync(join(target, name), 'utf8'));
      const validation = validateMeasurement(value);
      if (!validation.ok) {
        errors.push(`${name}: ${validation.errors.join('; ')}`);
      } else if (`${value.recordId}.json` !== name) {
        errors.push(`${name}: filename does not match recordId`);
      } else {
        records.push(value);
      }
    } catch (error) {
      errors.push(`${name}: ${error.message}`);
    }
  }
  return { ok: errors.length === 0, records, errors };
}

function observed(value) {
  return { status: 'observed', value };
}

function unavailable(reason = 'fixture provider did not expose this field') {
  return { status: 'unavailable', reason };
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
    fixtureSegment({ id: 'plan', stage: 'plan-review', requestedRoute: external }),
    fixtureSegment({ id: 'write', stage: 'implementation', requestedRoute: external }),
    fixtureSegment({ id: 'review-1', stage: 'code-review', requestedRoute: external }),
    fixtureSegment({
      id: 'review-2',
      stage: 'code-review',
      round: 2,
      requestedRoute: native,
    }),
    fixtureSegment({ id: 'gate', stage: 'gate', requestedRoute: native }),
    fixtureSegment({ id: 'delivery', stage: 'delivery', requestedRoute: native }),
  ];
  const sum = (key) => segments.reduce(
    (value, segment) => value + (observationValue(segment.telemetry[key]) ?? 0),
    0,
  );
  return {
    version: MEASUREMENT_VERSION,
    recordId: '123e4567-e89b-42d3-a456-426614174000',
    capturedAt: '2026-07-24T00:00:00.000Z',
    revision: 'a'.repeat(40),
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
        durationMs: 40,
        reviewRounds: 2,
        findings: { critical: 0, major: 1, minor: 1 },
        rebuts: { accepted: 1, rejected: 0 },
      },
      outcomes: {
        gate: { result: 'first-pass', localGreenCiRed: false },
        recovery: { resumeKind: 'fresh', recoveryKind: 'not-needed', contextParks: 0 },
        overlap: { stagedAheadUnits: 1, utilizedUnits: 1, avoidedIdleWait: null },
        laneEffectiveness: {
          falseClassifications: 0,
          scopeDriftFallbacks: 0,
          avoidedEngineTime: null,
        },
        avoidedRework: {
          partialClaimsResumed: 0,
          auditRecordsBackfilled: 0,
          duplicateScansAvoided: 1,
          falseDoctorFailuresPrevented: 0,
          avoidedTime: null,
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
  }));
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

function selfTest() {
  const valid = fixtureRecord();
  const unknown = { ...valid, actualRoute: 'retired-top-level-route' };
  const impossible = fixtureRecord(100, {
    activeHost: 'codex',
    selector: 'claude',
    requestedEngine: 'claude',
    requestedRoute: 'claude.native',
  });
  const invalidAdapter = structuredClone(valid);
  invalidAdapter.segments[0].adapter = 'claude.native';
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
  }));
  const comparison = compareCheckpoints([...legacy, ...safe]);
  const baseline = fixtureRecords(100, 'safe-system');
  const source = buildBudgetSource(baseline);
  const budget = fixtureBudget(source);
  const current = fixtureRecords(100, 'post-optimization', 80).map((recordValue, index) => ({
    ...recordValue,
    recordId: `423e4567-e89b-42d3-a456-${String(426614174000 + index).padStart(12, '0')}`,
  }));
  const passedBudget = evaluateBudget(budget, baseline, current);
  const failedBudget = evaluateBudget(
    { ...budget, limits: { ...budget.limits, unitTimeP95Ms: 100 } },
    baseline,
    current,
  );
  const shortBaseline = fixtureRecords(20, 'safe-system');
  const shortSource = buildBudgetSource(shortBaseline);
  const provisionalBudget = evaluateBudget(
    fixtureBudget(shortSource),
    shortBaseline,
    fixtureRecords(20, 'post-optimization').map((recordValue, index) => ({
      ...recordValue,
      recordId: `523e4567-e89b-42d3-a456-${String(426614174000 + index).padStart(12, '0')}`,
    })),
  );
  const tinyBaseline = fixtureRecords(19, 'safe-system');
  const tinySource = buildBudgetSource(tinyBaseline);
  const refusedBudget = evaluateBudget(
    fixtureBudget(tinySource),
    tinyBaseline,
    fixtureRecords(19, 'post-optimization').map((recordValue, index) => ({
      ...recordValue,
      recordId: `623e4567-e89b-42d3-a456-${String(426614174000 + index).padStart(12, '0')}`,
    })),
  );
  const claim = structuredClone(valid);
  claim.unit.outcomes.laneEffectiveness.avoidedEngineTime = {
    value: 100,
    unit: 'milliseconds',
    method: 'matched-control',
    evidenceFingerprint: 'e'.repeat(64),
    controlRecordIds: [],
  };
  const tempDirectory = join(tmpdir(), `autoloop-measurement-${randomUUID()}`);
  const persisted = persistMeasurement(valid, tempDirectory);
  const duplicate = persistMeasurement(valid, tempDirectory);
  const stored = readMeasurements(tempDirectory);
  const persistedMode = statSync(persisted.path).mode & 0o777;
  rmSync(tempDirectory, { recursive: true, force: true });
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
    ['dynamic unit steps are summarized', !!summary.unitCohorts[0]?.metrics['unit.timing.steps.gate']],
    ['segment cohorts retain stage and route', summary.segmentCohorts.some(
      ({ cohort }) =>
        cohort.stage === 'code-review'
        && cohort.actualSegmentRoute === 'claude.native',
    )],
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
    ['stable matching budget passes', passedBudget.status === 'passed'],
    ['stable regression fails its metric limit', failedBudget.status === 'failed'],
    ['budget stays provisional below stable floor', provisionalBudget.status === 'provisional'],
    ['p95 budget refuses below reporting floor', refusedBudget.status === 'refused'],
    ['raw record persists once at mode 0600', persisted.ok && !duplicate.ok
      && persistedMode === 0o600],
    ['raw records remain recomputable', stored.ok && stored.records.length === 1],
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
  const gitPath = execFileSync(
    'git',
    ['rev-parse', '--git-path', 'autoloop/measurements/v1'],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    },
  ).trim();
  if (!gitPath) throw new Error('git returned an empty measurement path');
  return resolve(process.cwd(), gitPath);
}

function readJsonInput() {
  try {
    return { ok: true, value: JSON.parse(readFileSync(0, 'utf8')) };
  } catch (error) {
    return { ok: false, error: `invalid JSON input: ${error.message}` };
  }
}

function writeResult(result, success = result.ok !== false) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(success ? 0 : 1);
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(`measurement-contract: ${parsed.error}`);
    process.exit(2);
  }
  if (parsed.mode === 'self-test') process.exit(selfTest() ? 0 : 1);
  if (parsed.mode === 'summarize-store') {
    let stored;
    try {
      stored = readMeasurements(measurementDirectory());
    } catch (error) {
      console.error(`measurement-contract: cannot resolve Git measurement storage: ${error.message}`);
      process.exit(1);
    }
    if (!stored.ok) writeResult(stored, false);
    writeResult({
      ok: true,
      recordCount: stored.records.length,
      summary: summarizeMeasurements(stored.records),
    });
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
    const records = Array.isArray(input.value) ? input.value : [input.value];
    writeResult(buildBudgetSource(records));
  }
  if (parsed.mode === 'evaluate-budget') {
    if (
      !exactObject(
        [],
        'evaluation',
        input.value,
        ['budget', 'baselineRecords', 'currentRecords'],
      )
      || !Array.isArray(input.value.baselineRecords)
      || !Array.isArray(input.value.currentRecords)
    ) {
      writeResult({ ok: false, status: 'refused', errors: ['invalid evaluation input'] }, false);
    }
    writeResult(evaluateBudget(
      input.value.budget,
      input.value.baselineRecords,
      input.value.currentRecords,
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
if (isMain) main();
