#!/usr/bin/env node

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  finish,
  open,
} from './runtime-contract.mjs';

const MAX_INPUT_BYTES = 1024 * 1024;

export function openRunScope(input) {
  return open(input);
}

export function finishRunScope(input) {
  return finish(input);
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
    && ['--open-json', '--finish-json'].includes(args[0])
    && typeof args[1] === 'string'
    && args[1].length > 0
  ) {
    return {
      mode: args[0] === '--open-json' ? 'open' : 'finish',
      path: args[1],
      error: null,
    };
  }
  return {
    mode: null,
    path: null,
    error: 'expected --open-json <path|->, --finish-json <path|->, or --self-test',
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
      runWallClockHours: 4,
      gateRetriesPerUnit: 2,
      reviseRoundsPerPr: 3,
      codeReviewRoundsPerUnit: 3,
      sliceMaxLines: 500,
      sliceMaxFiles: 10,
    },
  };
}

function hostFixture() {
  return {
    kind: 'autoloop-host-evidence',
    version: 1,
    source: 'live-integration',
    observedHosts: ['claude'],
    fingerprint: 'a'.repeat(64),
  };
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
      'legacy free-form CLI is rejected',
      parseArgs(['/autoloop:dev']).error?.includes('--open-json'),
    ],
    ['open CLI parses', parseArgs(['--open-json', '-']).mode === 'open'],
    ['finish CLI parses', parseArgs(['--finish-json', '/tmp/finish.json']).mode === 'finish'],
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
  const result = parsed.mode === 'open' ? openRunScope(input) : finishRunScope(input);
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
