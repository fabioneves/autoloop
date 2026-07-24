#!/usr/bin/env node

import {
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function canonicalTimestamp(value) {
  if (!ISO_RE.test(value ?? '')) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
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
  if (!UUID_RE.test(value.recordId ?? '')) errors.push('recordId: expected a lowercase UUID v4');
  if (!canonicalTimestamp(value.capturedAt)) {
    errors.push('capturedAt: expected a canonical UTC timestamp');
  }
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

  const unavailable = new Map();
  if (!Array.isArray(value.unavailable)) {
    errors.push('unavailable: expected an array of typed reasons');
  } else {
    for (const entry of value.unavailable) {
      if (
        !entry
        || typeof entry !== 'object'
        || Array.isArray(entry)
        || Object.keys(entry).sort().join('\0') !== 'field\0reason'
        || typeof entry.field !== 'string'
        || entry.field.length === 0
        || typeof entry.reason !== 'string'
        || entry.reason.length === 0
      ) {
        errors.push('unavailable: each entry must contain only non-empty field and reason strings');
        continue;
      }
      if (unavailable.has(entry.field)) errors.push(`unavailable: duplicate field ${entry.field}`);
      unavailable.set(entry.field, entry.reason);
    }
  }
  for (const role of ['orchestrator', 'implementer', 'reviewer']) {
    for (const field of ['input', 'cachedInput', 'output', 'reasoning']) {
      const tokenValue = value.tokens?.[role]?.[field];
      const path = `tokens.${role}.${field}`;
      if (tokenValue === null && unavailable.has(path)) continue;
      if (!integer(tokenValue)) errors.push(`${path}: expected a non-negative integer or declared unavailable`);
    }
  }
  for (const field of ['orchestratorBytes', 'implementerBytes', 'reviewerBytes']) {
    const path = `context.${field}`;
    const contextValue = value.context?.[field];
    if (contextValue === null && unavailable.has(path)) continue;
    if (!integer(contextValue)) {
      errors.push(`${path}: expected a non-negative integer or declared unavailable`);
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
  if (!new Set(['not-needed', 'resumed', 'reconciled', 'blocked']).has(value.outcomes?.recoveryKind)) {
    errors.push('outcomes.recoveryKind: unsupported value');
  }
  if (value.legacyProfile !== undefined && !HOSTS.has(value.legacyProfile)) {
    errors.push('legacyProfile: expected claude, codex, or opencode when present');
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
  'tokens.orchestrator.input',
  'tokens.orchestrator.cachedInput',
  'tokens.orchestrator.output',
  'tokens.orchestrator.reasoning',
  'tokens.implementer.input',
  'tokens.implementer.cachedInput',
  'tokens.implementer.output',
  'tokens.implementer.reasoning',
  'tokens.reviewer.input',
  'tokens.reviewer.cachedInput',
  'tokens.reviewer.output',
  'tokens.reviewer.reasoning',
  'context.orchestratorBytes',
  'context.implementerBytes',
  'context.reviewerBytes',
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
    recordValue.adapter,
    recordValue.degradation,
    recordValue.intentSource,
    recordValue.lane,
    recordValue.stage,
    recordValue.round,
    recordValue.mergePolicy,
    recordValue.baseFreshnessStrategy,
    recordValue.configFingerprint,
    recordValue.capabilityFingerprint,
    recordValue.outageTransition,
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
      const samples = values
        .map((value) => valueAt(value, path))
        .filter((sample) => finiteNumber(sample));
      metrics[path] = {
        sampleCount: samples.length,
        unavailableCount: values.length - samples.length,
        median: samples.length > 0 ? median(samples) : null,
        p95: samples.length >= 20 ? nearestRank(samples, 0.95) : null,
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
        adapter: first.adapter,
        degradation: first.degradation,
        intentSource: first.intentSource,
        lane: first.lane,
        stage: first.stage,
        round: first.round,
        mergePolicy: first.mergePolicy,
        baseFreshnessStrategy: first.baseFreshnessStrategy,
        configFingerprint: first.configFingerprint,
        capabilityFingerprint: first.capabilityFingerprint,
        outageTransition: first.outageTransition,
      },
      sampleCount: values.length,
      p95Provisional: values.length < 100,
      metrics,
    };
  });
}

export function persistMeasurement(recordValue, directory) {
  const validation = validateMeasurement(recordValue);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors };
  }
  const targetDirectory = resolve(directory);
  mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
  const path = join(targetDirectory, `${recordValue.recordId}.json`);
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, `${JSON.stringify(recordValue)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    return { ok: true, path };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    return {
      ok: false,
      errors: [`record persistence failed: ${error.message}`],
    };
  }
}

export function readMeasurements(directory) {
  const records = [];
  const errors = [];
  let names;
  try {
    names = readdirSync(resolve(directory))
      .filter((name) => name.endsWith('.json'))
      .sort();
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
      const value = JSON.parse(readFileSync(join(resolve(directory), name), 'utf8'));
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

function record(totalMs, overrides = {}) {
  return {
    version: MEASUREMENT_VERSION,
    recordId: '123e4567-e89b-42d3-a456-426614174000',
    capturedAt: '2026-07-24T00:00:00.000Z',
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
    context: {
      orchestratorBytes: 2000,
      implementerBytes: 1000,
      reviewerBytes: null,
    },
    calls: { githubApi: 4, subprocesses: 3, remoteMutations: 1 },
    dispatch: { count: 2, durationMs: 20, reviewRounds: 1, findingYield: 0, acceptedRebuts: 0 },
    outcomes: {
      firstPassGate: true,
      localGreenCiRed: false,
      contextParked: false,
      resumeKind: 'fresh',
      recoveryKind: 'not-needed',
    },
    unavailable: [
      { field: 'tokens.implementer.reasoning', reason: 'provider did not report reasoning tokens' },
      { field: 'context.reviewerBytes', reason: 'host did not expose reviewer context bytes' },
    ],
    ...overrides,
  };
}

function selfTest() {
  const valid = record(100);
  const invalid = record(100, { actualRoute: 'codex.made-up' });
  const two = summarizeMeasurements([record(100), record(200)]);
  const twenty = summarizeMeasurements(Array.from(
    { length: 20 },
    (_, index) => record(index + 101, {
      recordId: `123e4567-e89b-42d3-a456-${String(426614174000 + index).padStart(12, '0')}`,
    }),
  ));
  const tempDirectory = join(tmpdir(), `autoloop-measurement-${randomUUID()}`);
  const persisted = persistMeasurement(valid, tempDirectory);
  const duplicate = persistMeasurement(valid, tempDirectory);
  const stored = readMeasurements(tempDirectory);
  rmSync(tempDirectory, { recursive: true, force: true });
  const cases = [
    ['valid measurement', validateMeasurement(valid).ok],
    ['unknown route rejected', !validateMeasurement(invalid).ok],
    ['even median averages middle pair', two[0]?.metrics?.['timing.totalMs']?.median === 150],
    ['p95 withheld below 20 samples', two[0]?.metrics?.['timing.totalMs']?.p95 === null],
    ['nearest-rank p95 emitted at 20', twenty[0]?.metrics?.['timing.totalMs']?.p95 === 119],
    ['p95 budget remains provisional below 100', twenty[0]?.p95Provisional === true],
    ['raw record persists once', persisted.ok && !duplicate.ok],
    ['raw records remain recomputable', stored.ok && stored.records.length === 1],
    [
      'unavailable provider fact requires a reason',
      !validateMeasurement(record(100, {
        unavailable: [{ field: 'tokens.implementer.reasoning', reason: '' }],
      })).ok,
    ],
  ];
  let passed = 0;
  for (const [name, ok] of cases) {
    if (!ok) console.error(`FAIL ${name}`);
    else passed += 1;
  }
  console.log(passed === cases.length ? `self-test OK (${passed} cases)` : `self-test FAILED (${passed}/${cases.length})`);
  return passed === cases.length;
}

function parseArgs(args) {
  if (args.length === 1 && args[0] === '--self-test') {
    return { mode: 'self-test', directory: null, error: null };
  }
  if (args.length === 0) {
    return { mode: 'summarize', directory: null, error: null };
  }
  if (args.length === 1 && args[0] === '--record') {
    return { mode: 'record', directory: null, error: null };
  }
  if (args.length === 1 && args[0] === '--summarize-store') {
    return { mode: 'summarize-store', directory: null, error: null };
  }
  return {
    mode: null,
    directory: null,
    error: 'expected --record, --summarize-store, --self-test, or no arguments',
  };
}

function measurementDirectory() {
  const gitPath = execFileSync(
    'git',
    ['rev-parse', '--git-path', 'autoloop/measurements/v1'],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
    },
  ).trim();
  if (!gitPath) throw new Error('git returned an empty measurement path');
  return resolve(process.cwd(), gitPath);
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
    if (!stored.ok) {
      process.stdout.write(`${JSON.stringify(stored)}\n`);
      process.exit(1);
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      recordCount: stored.records.length,
      cohorts: summarizeMeasurements(stored.records),
    }, null, 2)}\n`);
    return;
  }
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch (error) {
    console.error(`measurement-contract: invalid JSON input: ${error.message}`);
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
    const result = persistMeasurement(input, directory);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(result.ok ? 0 : 1);
  }
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
