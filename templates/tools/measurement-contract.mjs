#!/usr/bin/env node

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MEASUREMENT_VERSION = 1;

const HOSTS = new Set(['claude', 'codex', 'opencode']);
const SELECTORS = new Set(['native', ...HOSTS]);
const ROUTES = new Set([
  'claude.native',
  'codex.native',
  'opencode.native',
  'claude.codex-exec',
  'claude.opencode-exec',
]);
const LANES = new Set(['docs', 'small', 'full']);
const STAGES = new Set(['plan-review', 'implementation', 'code-review', 'judgment', 'gate', 'delivery']);
const MERGE_POLICIES = new Set(['manual', 'ratified', 'auto']);
const BASE_STRATEGIES = new Set(['manual', 'strict', 'merge-queue']);
const INTENT_SOURCES = new Set(['invocation', 'relaunch', 'orphan-recovery']);
const SHA_RE = /^[0-9a-f]{40}$/i;
const HASH_RE = /^[0-9a-f]{64}$/i;

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function integer(value) {
  return Number.isInteger(value) && value >= 0;
}

function requireEnum(errors, path, value, values) {
  if (!values.has(value)) errors.push(`${path}: unsupported value ${JSON.stringify(value)}`);
}

function requireNumbers(errors, value, paths, integerOnly = false) {
  for (const path of paths) {
    const field = value?.[path];
    if (!(integerOnly ? integer(field) : finiteNumber(field))) {
      errors.push(`${path}: expected a non-negative ${integerOnly ? 'integer' : 'number'}`);
    }
  }
}

export function validateMeasurement(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['record: expected an object'] };
  }
  if (value.version !== MEASUREMENT_VERSION) errors.push(`version: expected ${MEASUREMENT_VERSION}`);
  if (!SHA_RE.test(value.revision ?? '')) errors.push('revision: expected a 40-character commit OID');
  if (typeof value.workload !== 'string' || value.workload.length === 0) errors.push('workload: expected a non-empty string');
  requireEnum(errors, 'activeHost', value.activeHost, HOSTS);
  requireEnum(errors, 'selector', value.selector, SELECTORS);
  requireEnum(errors, 'requestedEngine', value.requestedEngine, HOSTS);
  requireEnum(errors, 'requestedRoute', value.requestedRoute, ROUTES);
  requireEnum(errors, 'actualRoute', value.actualRoute, ROUTES);
  requireEnum(errors, 'intentSource', value.intentSource, INTENT_SOURCES);
  requireEnum(errors, 'stage', value.stage, STAGES);
  requireEnum(errors, 'lane', value.lane, LANES);
  requireEnum(errors, 'mergePolicy', value.mergePolicy, MERGE_POLICIES);
  requireEnum(errors, 'baseFreshnessStrategy', value.baseFreshnessStrategy, BASE_STRATEGIES);
  const expectedEngine = value.selector === 'native' ? value.activeHost : value.selector;
  if (HOSTS.has(value.activeHost) && SELECTORS.has(value.selector) && value.requestedEngine !== expectedEngine) {
    errors.push(`requestedEngine: expected ${JSON.stringify(expectedEngine)} from selector`);
  }
  if (typeof value.adapter !== 'string' || value.adapter.length === 0) errors.push('adapter: expected a non-empty string');
  if (value.degradation !== null && typeof value.degradation !== 'string') errors.push('degradation: expected null or string');
  if (!Number.isInteger(value.round) || value.round < 0) errors.push('round: expected a non-negative integer');
  if (!HASH_RE.test(value.configFingerprint ?? '')) errors.push('configFingerprint: expected sha256');
  if (!HASH_RE.test(value.capabilityFingerprint ?? '')) errors.push('capabilityFingerprint: expected sha256');
  if (value.outageTransition !== null && typeof value.outageTransition !== 'string') {
    errors.push('outageTransition: expected null or string');
  }
  if (!finiteNumber(value.instrumentationOverheadMs)) {
    errors.push('instrumentationOverheadMs: expected a non-negative number');
  }

  requireNumbers(errors, value.timing, [
    'timeToFirstSelectionMs',
    'totalMs',
    'activeMs',
    'engineWaitMs',
    'ciWaitMs',
    'humanWaitMs',
  ]);
  if (!value.timing?.steps || typeof value.timing.steps !== 'object' || Array.isArray(value.timing.steps)) {
    errors.push('timing.steps: expected an object');
  } else {
    for (const [step, duration] of Object.entries(value.timing.steps)) {
      if (!step || !finiteNumber(duration)) errors.push(`timing.steps.${step}: expected a non-negative number`);
    }
  }
  if (
    finiteNumber(value.timing?.totalMs) &&
    ['activeMs', 'engineWaitMs', 'ciWaitMs', 'humanWaitMs'].every((key) => finiteNumber(value.timing?.[key])) &&
    value.timing.activeMs + value.timing.engineWaitMs + value.timing.ciWaitMs + value.timing.humanWaitMs > value.timing.totalMs
  ) {
    errors.push('timing: active and wait components exceed totalMs');
  }

  const unavailable = new Set(Array.isArray(value.unavailable) ? value.unavailable : []);
  if (!Array.isArray(value.unavailable) || [...unavailable].some((entry) => typeof entry !== 'string')) {
    errors.push('unavailable: expected an array of field paths');
  }
  for (const role of ['orchestrator', 'implementer', 'reviewer']) {
    for (const field of ['input', 'cachedInput', 'output', 'reasoning']) {
      const tokenValue = value.tokens?.[role]?.[field];
      const path = `${role}.${field}`;
      if (tokenValue === null && unavailable.has(path)) continue;
      if (!integer(tokenValue)) errors.push(`tokens.${path}: expected a non-negative integer or declared unavailable`);
    }
  }
  requireNumbers(errors, value.calls, ['githubApi', 'subprocesses', 'remoteMutations'], true);
  requireNumbers(errors, value.dispatch, [
    'count',
    'durationMs',
    'reviewRounds',
    'findingYield',
    'acceptedRebuts',
  ], true);
  for (const flag of ['firstPassGate', 'localGreenCiRed', 'contextParked']) {
    if (typeof value.outcomes?.[flag] !== 'boolean') errors.push(`outcomes.${flag}: expected boolean`);
  }
  if (!new Set(['fresh', 'resumed', 'restarted']).has(value.outcomes?.resumeKind)) {
    errors.push('outcomes.resumeKind: unsupported value');
  }
  return { ok: errors.length === 0, errors };
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
  return path.split('.').reduce((current, key) => current?.[key], recordValue);
}

const METRICS = [
  'timing.timeToFirstSelectionMs',
  'timing.totalMs',
  'timing.activeMs',
  'timing.engineWaitMs',
  'timing.ciWaitMs',
  'timing.humanWaitMs',
  'instrumentationOverheadMs',
  'calls.githubApi',
  'calls.subprocesses',
  'calls.remoteMutations',
  'dispatch.count',
  'dispatch.durationMs',
  'dispatch.reviewRounds',
  'dispatch.findingYield',
  'dispatch.acceptedRebuts',
];

function cohortKey(recordValue) {
  return [
    recordValue.revision,
    recordValue.workload,
    recordValue.activeHost,
    recordValue.selector,
    recordValue.requestedRoute,
    recordValue.actualRoute,
    recordValue.lane,
    recordValue.stage,
    recordValue.round,
    recordValue.mergePolicy,
    recordValue.baseFreshnessStrategy,
  ].join('\u001f');
}

export function summarizeMeasurements(records) {
  const cohorts = new Map();
  for (const recordValue of records) {
    if (!validateMeasurement(recordValue).ok) continue;
    const key = cohortKey(recordValue);
    if (!cohorts.has(key)) cohorts.set(key, []);
    cohorts.get(key).push(recordValue);
  }
  return [...cohorts.values()].map((values) => {
    const first = values[0];
    const metrics = {};
    for (const path of METRICS) {
      const samples = values.map((value) => valueAt(value, path));
      const name = path.split('.').at(-1);
      metrics[name] = {
        median: median(samples),
        p95: values.length >= 20 ? nearestRank(samples, 0.95) : null,
      };
    }
    return {
      cohort: {
        revision: first.revision,
        workload: first.workload,
        activeHost: first.activeHost,
        selector: first.selector,
        requestedRoute: first.requestedRoute,
        actualRoute: first.actualRoute,
        lane: first.lane,
        stage: first.stage,
        round: first.round,
        mergePolicy: first.mergePolicy,
        baseFreshnessStrategy: first.baseFreshnessStrategy,
      },
      sampleCount: values.length,
      p95Provisional: values.length < 100,
      metrics,
    };
  });
}

function record(totalMs, overrides = {}) {
  return {
    version: MEASUREMENT_VERSION,
    revision: 'a'.repeat(40),
    workload: 'fixture-full',
    activeHost: 'codex',
    selector: 'native',
    requestedEngine: 'codex',
    requestedRoute: 'codex.native',
    actualRoute: 'codex.native',
    intentSource: 'invocation',
    adapter: 'codex.native',
    degradation: null,
    stage: 'code-review',
    round: 1,
    lane: 'full',
    mergePolicy: 'manual',
    baseFreshnessStrategy: 'strict',
    configFingerprint: 'b'.repeat(64),
    capabilityFingerprint: 'c'.repeat(64),
    outageTransition: null,
    instrumentationOverheadMs: 2,
    timing: {
      timeToFirstSelectionMs: 10,
      totalMs,
      activeMs: totalMs - 30,
      engineWaitMs: 10,
      ciWaitMs: 10,
      humanWaitMs: 10,
      steps: { plan: 5 },
    },
    tokens: {
      orchestrator: { input: 100, cachedInput: 50, output: 20, reasoning: 10 },
      implementer: { input: 50, cachedInput: 0, output: 20, reasoning: null },
      reviewer: { input: 80, cachedInput: 0, output: 10, reasoning: 5 },
    },
    calls: { githubApi: 4, subprocesses: 3, remoteMutations: 1 },
    dispatch: { count: 2, durationMs: 20, reviewRounds: 1, findingYield: 0, acceptedRebuts: 0 },
    outcomes: {
      firstPassGate: true,
      localGreenCiRed: false,
      contextParked: false,
      resumeKind: 'fresh',
    },
    unavailable: ['implementer.reasoning'],
    ...overrides,
  };
}

function selfTest() {
  const valid = record(100);
  const invalid = record(100, { actualRoute: 'codex.made-up' });
  const two = summarizeMeasurements([record(100), record(200)]);
  const twenty = summarizeMeasurements(Array.from({ length: 20 }, (_, index) => record(index + 101)));
  const cases = [
    ['valid measurement', validateMeasurement(valid).ok],
    ['unknown route rejected', !validateMeasurement(invalid).ok],
    ['even median averages middle pair', two[0]?.metrics?.totalMs?.median === 150],
    ['p95 withheld below 20 samples', two[0]?.metrics?.totalMs?.p95 === null],
    ['nearest-rank p95 emitted at 20', twenty[0]?.metrics?.totalMs?.p95 === 119],
    ['p95 budget remains provisional below 100', twenty[0]?.p95Provisional === true],
  ];
  let passed = 0;
  for (const [name, ok] of cases) {
    if (!ok) console.error(`FAIL ${name}`);
    else passed += 1;
  }
  console.log(passed === cases.length ? `self-test OK (${passed} cases)` : `self-test FAILED (${passed}/${cases.length})`);
  return passed === cases.length;
}

function main() {
  if (process.argv.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const records = Array.isArray(input) ? input : [input];
  const invalid = records.map(validateMeasurement).filter((result) => !result.ok);
  if (invalid.length > 0) {
    process.stdout.write(`${JSON.stringify({ ok: false, invalid })}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, cohorts: summarizeMeasurements(records) }, null, 2)}\n`);
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
