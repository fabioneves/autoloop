#!/usr/bin/env node

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  finish,
  initializeRouteState,
  observe,
  open,
  plan,
  refreshRouteState,
  transitionContinuationLease,
} from './runtime-contract.mjs';
import {
  authorizeNativeAttempt,
  compileRouteAttempt,
  executeRouteAttempt,
  issueCapabilitySnapshot,
  issueHostEvidence,
  recordRouteAttempt,
} from './route-adapter-contract.mjs';

const MAX_INPUT_BYTES = 1024 * 1024;

export function openRunScope(input) {
  return open(input);
}

export function finishRunScope(input) {
  return finish(input);
}

export function transitionRunContinuation(input) {
  return transitionContinuationLease(input);
}

const OPERATION_FLAGS = Object.freeze({
  '--attest-host-json': ['attest-host', issueHostEvidence],
  '--probe-json': ['probe', issueCapabilitySnapshot],
  '--open-json': ['open', open],
  '--initialize-route-state-json': ['initialize-route-state', initializeRouteState],
  '--refresh-route-state-json': ['refresh-route-state', refreshRouteState],
  '--plan-json': ['plan', plan],
  '--compile-json': ['compile', compileRouteAttempt],
  '--authorize-native-json': ['authorize-native', authorizeNativeAttempt],
  '--classify-json': ['classify', recordRouteAttempt],
  '--execute-json': ['execute', executeRouteAttempt],
  '--observe-json': ['observe', observe],
  '--finish-json': ['finish', finish],
  '--transition-continuation-json': [
    'transition-continuation',
    transitionContinuationLease,
  ],
});

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

function selfTest() {
  const queue = openRunScope({
    invocation: '/autoloop:dev',
    hostEvidence: hostFixture(),
    config: configFixture(),
  });
  const bounded = openRunScope({
    invocation: '/autoloop:dev only #7',
    hostEvidence: hostFixture(),
    config: configFixture(),
  });
  const stop = queue.ok
    ? finishRunScope({
        run: queue.value,
        progress: {
          reason: 'queue-exhausted',
          eligibleRemaining: 0,
          unitsCompleted: 2,
          queueComplete: true,
        },
      })
    : null;
  const incomplete = queue.ok
    ? finishRunScope({
        run: queue.value,
        progress: {
          reason: 'queue-exhausted',
          eligibleRemaining: 0,
          unitsCompleted: 2,
          queueComplete: false,
        },
      })
    : null;
  const wallClock = queue.ok
    ? finishRunScope({
        run: queue.value,
        progress: {
          reason: 'wall-clock-cap',
          eligibleRemaining: 1,
          unitsCompleted: 1,
          queueComplete: true,
        },
      })
    : null;
  const relaunchSource = openRunScope({
    invocation: '/autoloop:dev; auto-continue',
    hostEvidence: hostFixture(),
    config: configFixture(),
  });
  const relaunch = relaunchSource.ok
    ? finishRunScope({
        run: relaunchSource.value,
        progress: {
          reason: 'context-budget',
          eligibleRemaining: 1,
          unitsCompleted: 1,
          queueComplete: true,
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
      'native authorization CLI parses',
      parseArgs(['--authorize-native-json', '-']).mode === 'authorize-native',
    ],
    ['classify CLI parses', parseArgs(['--classify-json', '-']).mode === 'classify'],
    ['observe CLI parses', parseArgs(['--observe-json', '-']).mode === 'observe'],
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

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(`run-scope: ${parsed.error}`);
    process.exit(2);
  }
  if (parsed.mode === 'self-test') process.exit(selfTest() ? 0 : 1);

  let input;
  try {
    input = readJsonInput(parsed.path);
  } catch (error) {
    console.error(`run-scope: unable to read JSON input: ${error.message}`);
    process.exit(2);
  }
  const operation = Object.values(OPERATION_FLAGS)
    .find(([name]) => name === parsed.mode)?.[1];
  const result = operation(input);
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

if (isMainModule()) main();
