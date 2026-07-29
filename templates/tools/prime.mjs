#!/usr/bin/env node

// One-call prime: everything a run needs before it can choose work.
//
//   1. Validate ProjectConfig from STATE (in process — no child).
//   2. Check the checkout against the configured base (a handful of cheap
//      plumbing reads, no fetch, no mutation).
//   3. Run exactly ONE `scan.mjs` child for the versioned startup snapshot.
//   4. Persist the snapshot and print a decision-sized summary.
//
// The hot path is deliberately one child process. The predecessor spawned five
// (attest, open, bind-measurement, a capture event, a measured scan wrapper),
// each of which had to be hand-assembled by the model from broker internals; a
// live run spent 5.5 minutes reverse-engineering those envelopes and still
// failed closed. Config validation is an import, not a subprocess, and the
// scan's output is read once and written once.
//
// Usage:
//   node tools/agentic/prime.mjs [--json] [--scan-arg <value>]...
//   node tools/agentic/prime.mjs --self-test

import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ancestorPids,
  loopRunIsOpen,
  runMarkerDirectory,
} from './command-guard.mjs';
import { extractConfig, validateProjectConfig } from './config-contract.mjs';
import { snapshotExecutionRepository } from './checkout-contract.mjs';
import { SNAPSHOT_SECTIONS, writeStdoutSync } from './snapshot-contract.mjs';

// Bumped by every release together with the other version literals; the
// release verifier requires this literal to equal VERSION.
const AUTOLOOP_VERSION = '0.49.34';

const MAX_CHILD_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_SCAN_ARGS = 8;
// The scan is dominated by GitHub round trips on a large repository, not by
// local work; this bound only catches a wedged child.
const SCAN_TIMEOUT_MS = 20 * 60 * 1000;
const GIT_TIMEOUT_MS = 15_000;
const TOOL_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const SCAN_TOOL = join(TOOL_DIRECTORY, 'scan.mjs');
const PROCESS_START_MS = Date.now();

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function failure(step, code, message, detail = {}) {
  return { ok: false, step, error: { code, message, ...detail } };
}

function git(root, args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  });
  return {
    ok: result.status === 0 && !result.error,
    value: String(result.stdout ?? '').trim(),
    detail: result.error?.message ?? String(result.stderr ?? '').trim(),
  };
}

export function validateScanArgs(scanArgs) {
  return Array.isArray(scanArgs)
    && scanArgs.length <= MAX_SCAN_ARGS
    && scanArgs.every((argument) =>
      typeof argument === 'string'
      && argument.length >= 1
      && argument.length <= 256
      && !/[\x00-\x1f\x7f]/.test(argument));
}

export function verifySnapshotShape(snapshot) {
  if (!plainObject(snapshot) || snapshot.kind !== 'autoloop-repository-snapshot') {
    return ['snapshot: expected an autoloop-repository-snapshot object'];
  }
  if (!plainObject(snapshot.sections)) {
    return ['snapshot.sections: expected a section object'];
  }
  const errors = [];
  const names = Object.keys(snapshot.sections);
  const expected = [...SNAPSHOT_SECTIONS].sort().join(',');
  if ([...names].sort().join(',') !== expected) {
    errors.push(`snapshot.sections: expected exactly ${expected}`);
  }
  for (const name of names) {
    const section = snapshot.sections[name];
    if (
      !plainObject(section)
      || Object.keys(section).sort().join(',') !== 'complete,error,items'
      || !Array.isArray(section.items)
      || typeof section.complete !== 'boolean'
      || (section.error !== null && !plainObject(section.error))
    ) {
      errors.push(`snapshot.sections.${name}: expected {items,complete,error}`);
    }
  }
  return errors;
}

// The base check is advisory evidence, not a mutation: prime never fetches,
// switches, or resets. It reports what the caller is standing on so the skill
// can decide, which is exactly the decision a live run had to reconstruct by
// hand.
export function baseSyncFacts(root, baseBranch) {
  const head = git(root, ['rev-parse', 'HEAD']);
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const remoteBase = git(root, ['rev-parse', `refs/remotes/origin/${baseBranch}`]);
  const localBase = git(root, ['rev-parse', `refs/heads/${baseBranch}`]);
  const behind = remoteBase.ok && head.ok
    ? git(root, ['rev-list', '--count', `HEAD..refs/remotes/origin/${baseBranch}`])
    : { ok: false, value: '' };
  return {
    baseBranch,
    branch: branch.ok ? branch.value : null,
    headOid: head.ok ? head.value : null,
    localBaseOid: localBase.ok ? localBase.value : null,
    remoteBaseOid: remoteBase.ok ? remoteBase.value : null,
    onBase: branch.ok && branch.value === baseBranch,
    behindRemoteBase: behind.ok && /^\d+$/.test(behind.value)
      ? Number(behind.value)
      : null,
  };
}

export function primeDev({ cwd = process.cwd(), scanArgs = [] } = {}) {
  if (!validateScanArgs(scanArgs)) {
    return failure(
      'input',
      'INVALID_SCAN_ARGS',
      `scanArgs: expected at most ${MAX_SCAN_ARGS} bounded printable strings`,
    );
  }

  let snapshotRepository;
  try {
    snapshotRepository = snapshotExecutionRepository(cwd);
  } catch (error) {
    return failure('checkout', 'CHECKOUT_UNAVAILABLE', error.message);
  }
  const { checkout, repository } = snapshotRepository;
  const root = checkout.root;

  let config;
  try {
    config = extractConfig(
      readFileSync(join(root, 'docs', 'agentic', 'STATE.md'), 'utf8'),
    );
  } catch (error) {
    return failure('config', 'PROJECT_CONFIG_UNREADABLE', error.message);
  }
  const configErrors = validateProjectConfig(config);
  if (configErrors.length > 0) {
    return failure(
      'config',
      'PROJECT_CONFIG_INVALID',
      configErrors.join('; '),
      { errors: configErrors },
    );
  }

  const base = baseSyncFacts(root, config.baseBranch);
  const runMarker = writeRunMarker(root);

  const scanStartedAt = Date.now();
  const scan = spawnSync(process.execPath, [SCAN_TOOL, ...scanArgs], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: MAX_CHILD_OUTPUT_BYTES,
    timeout: SCAN_TIMEOUT_MS,
    windowsHide: true,
  });
  const scanMs = Date.now() - scanStartedAt;
  if (scan.error || scan.status !== 0) {
    return failure(
      'scan',
      'SCAN_FAILED',
      scan.error?.message
        ?? `scan.mjs exited ${scan.status}: ${String(scan.stderr ?? '').slice(0, 400)}`,
      { scanMs },
    );
  }
  let snapshot;
  try {
    snapshot = JSON.parse(scan.stdout);
  } catch (error) {
    return failure(
      'snapshot',
      'SNAPSHOT_PARSE_FAILED',
      `scan stdout is not JSON: ${error.message}`,
      { scanMs },
    );
  }
  const snapshotErrors = verifySnapshotShape(snapshot);
  if (snapshotErrors.length > 0) {
    return failure(
      'snapshot',
      'SNAPSHOT_SECTIONS_INVALID',
      snapshotErrors.join('; '),
      { scanMs },
    );
  }

  return {
    ok: true,
    version: AUTOLOOP_VERSION,
    repository: `${repository.owner}/${repository.repo}`,
    checkout,
    config: {
      version: config.version,
      baseBranch: config.baseBranch,
      mergePolicy: config.merge.policy,
      gateCommand: config.gate.command,
      checklistPath: config.review.checklistPath,
    },
    base,
    runMarker,
    timings: { scanMs, primeMs: Date.now() - PROCESS_START_MS },
    snapshot,
  };
}

// The command guard enforces only while a run is open, and this marker is that
// evidence: the ancestry prime observed, written durably, matched against the
// guard hook's own ancestry. It needs no revocation — a run whose orchestrator
// has exited leaves no live PID to match.
export function writeRunMarker(root, pids = [process.ppid, ...ancestorPids()]) {
  const directory = runMarkerDirectory(root);
  if (directory === null) return null;
  const live = [...new Set(pids)].filter(
    (pid) => Number.isSafeInteger(pid) && pid > 1,
  );
  if (live.length === 0) return null;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${process.pid}.json`);
  writeFileSync(path, `${JSON.stringify({ version: 1, pids: live })}\n`);
  return path;
}

export function sectionSummary(snapshot) {
  return Object.fromEntries(
    Object.entries(snapshot?.sections ?? {}).map(([name, section]) => [name, {
      complete: section?.complete === true,
      items: Array.isArray(section?.items) ? section.items.length : 0,
      ...(section?.error ? { error: section.error } : {}),
    }]),
  );
}

// A full snapshot is hundreds of kilobytes; a model-facing tool result is
// truncated far below that, which is how snapshot archaeology got reinvented
// every run. stdout carries decision-sized facts plus the path; the durable
// file carries every byte and the typed accessors read from it.
export function persistPrimeSnapshot(result, cwd = process.cwd()) {
  const directory = resolve(cwd, '.git', 'autoloop', 'prime');
  mkdirSync(directory, { recursive: true });
  const snapshotPath = resolve(
    directory,
    `${result.checkout?.headOid ?? 'run'}.snapshot.json`,
  );
  const bytes = `${JSON.stringify(result.snapshot, null, 1)}\n`;
  writeFileSync(snapshotPath, bytes);
  const { snapshot, ...compact } = result;
  return {
    ...compact,
    snapshotPath,
    snapshotBytes: Buffer.byteLength(bytes, 'utf8'),
    sections: sectionSummary(snapshot),
  };
}

function report(summary) {
  if (summary.ok !== true) {
    return `prime ${summary.step} FAILED  ${summary.error.code}\n${summary.error.message}`;
  }
  const lines = [
    `prime ok · v${summary.version} · ${summary.repository}`,
    `branch ${summary.base.branch} @ ${String(summary.checkout.headOid).slice(0, 12)}`
    + `  tree ${summary.checkout.clean ? 'clean' : 'DIRTY'}`,
    `base   ${summary.base.baseBranch}`
    + `  on-base ${summary.base.onBase ? 'yes' : 'no'}`
    + `  behind ${summary.base.behindRemoteBase ?? '?'}`,
    `config ${summary.config.version}  merge ${summary.config.mergePolicy}`
    + `  gate ${summary.config.gateCommand}`,
    `scan   ${summary.timings.scanMs}ms  prime ${summary.timings.primeMs}ms`
    + `  snapshot ${summary.snapshotBytes}B -> ${summary.snapshotPath}`,
    'section                    items  complete',
  ];
  for (const [name, section] of Object.entries(summary.sections)) {
    lines.push(
      `${name.padEnd(26)}${String(section.items).padStart(5)}  `
      + `${section.complete ? 'yes' : 'NO'}${section.error ? `  ${JSON.stringify(section.error).slice(0, 120)}` : ''}`,
    );
  }
  return lines.join('\n');
}

export function parseArgs(args) {
  const parsed = { mode: 'prime', json: false, scanArgs: [], error: null };
  if (args.length === 1 && args[0] === '--self-test') {
    return { ...parsed, mode: 'self-test' };
  }
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--json') {
      parsed.json = true;
      continue;
    }
    if (args[index] === '--scan-arg') {
      const value = args[index + 1];
      if (value === undefined) return { ...parsed, error: '--scan-arg: expected a value' };
      parsed.scanArgs.push(value);
      index += 1;
      continue;
    }
    return { ...parsed, error: `unknown argument ${args[index]}` };
  }
  return parsed;
}

function fixtureConfig() {
  return {
    version: '0.26.0',
    baseBranch: 'main',
    gate: { command: 'true', quickCommand: null, setupCommand: null },
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

function buildFixtureRepository(scratch, config) {
  const root = join(scratch, 'repo');
  mkdirSync(root, { recursive: true });
  const run = (args) => {
    const result = spawnSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
    });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed`);
  };
  run(['init', '--quiet', root]);
  run(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  run(['remote', 'add', 'origin', 'https://github.com/autoloop-fixtures/prime.git']);
  const statePath = join(root, 'docs', 'agentic', 'STATE.md');
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, [
    '# STATE — prime fixture',
    '',
    '```json autoloop-config',
    JSON.stringify(config, null, 2),
    '```',
    '',
  ].join('\n'));
  run(['add', '--all']);
  run([
    '-c', 'user.name=autoloop',
    '-c', 'user.email=autoloop@localhost',
    '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '-m', 'test: prime fixture',
  ]);
  return realpathSync(root);
}

function selfTest() {
  const failures = [];
  const cases = [];
  const check = (name, passed) => {
    cases.push(name);
    if (!passed) failures.push(name);
  };

  check(
    'scan arguments are bounded and printable',
    validateScanArgs([])
    && validateScanArgs(['--pr', '7'])
    && !validateScanArgs(['x'.repeat(257)])
    && !validateScanArgs([7])
    && !validateScanArgs(Array.from({ length: 9 }, () => '--pr'))
    && !validateScanArgs('--pr'),
  );

  const section = { items: [], complete: true, error: null };
  const sections = Object.fromEntries(
    SNAPSHOT_SECTIONS.map((name) => [name, section]),
  );
  check(
    'the exact snapshot section catalog passes shape verification',
    verifySnapshotShape({
      kind: 'autoloop-repository-snapshot',
      sections,
    }).length === 0,
  );
  check(
    'missing, extra, and malformed sections fail shape verification',
    verifySnapshotShape({
      kind: 'autoloop-repository-snapshot',
      sections: Object.fromEntries(Object.entries(sections).slice(0, 9)),
    }).length === 1
    && verifySnapshotShape({
      kind: 'autoloop-repository-snapshot',
      sections: { ...sections, invented: section },
    }).length === 1
    && verifySnapshotShape({
      kind: 'autoloop-repository-snapshot',
      sections: { ...sections, queue: { items: [], complete: true } },
    }).length === 1
    && verifySnapshotShape({ kind: 'other', sections }).length === 1
    && verifySnapshotShape(null).length === 1,
  );

  check(
    'argument parsing accepts only --json and repeated --scan-arg',
    parseArgs([]).error === null
    && parseArgs(['--json']).json === true
    && JSON.stringify(parseArgs(['--scan-arg', '--pr', '--scan-arg', '7']).scanArgs)
      === JSON.stringify(['--pr', '7'])
    && parseArgs(['--scan-arg']).error !== null
    && parseArgs(['--measure']).error !== null,
  );

  const scratch = mkdtempSync(join(tmpdir(), 'autoloop-prime-'));
  try {
    const root = buildFixtureRepository(scratch, fixtureConfig());
    const base = baseSyncFacts(root, 'main');
    check(
      'base facts report the live branch and a missing remote base honestly',
      base.baseBranch === 'main'
      && base.branch === 'main'
      && base.onBase === true
      && /^[0-9a-f]{40}$/.test(base.headOid)
      && base.remoteBaseOid === null
      && base.behindRemoteBase === null,
    );

    const invalid = primeDev({
      cwd: root,
      scanArgs: ['x'.repeat(300)],
    });
    check(
      'an invalid scan argument fails closed before any child runs',
      invalid.ok === false
      && invalid.step === 'input'
      && invalid.error.code === 'INVALID_SCAN_ARGS',
    );

    const outsideRepository = primeDev({ cwd: scratch });
    check(
      'a directory outside a checkout is a typed checkout failure',
      outsideRepository.ok === false
      && outsideRepository.step === 'checkout'
      && outsideRepository.error.code === 'CHECKOUT_UNAVAILABLE',
    );

    writeFileSync(
      join(root, 'docs', 'agentic', 'STATE.md'),
      '# STATE\n\n```json autoloop-config\n{"version":"0.0.0"}\n```\n',
    );
    const badConfig = primeDev({ cwd: root });
    check(
      'an invalid ProjectConfig is a typed config failure that names every error',
      badConfig.ok === false
      && badConfig.step === 'config'
      && badConfig.error.code === 'PROJECT_CONFIG_INVALID'
      && Array.isArray(badConfig.error.errors)
      && badConfig.error.errors.length > 0,
    );

    writeFileSync(join(root, 'docs', 'agentic', 'STATE.md'), '# STATE\n\nno config\n');
    const missingConfig = primeDev({ cwd: root });
    check(
      'a STATE without a config block is a typed config failure',
      missingConfig.ok === false
      && missingConfig.error.code === 'PROJECT_CONFIG_UNREADABLE',
    );

    const markerPath = writeRunMarker(root, [process.ppid]);
    check(
      'prime writes a run marker that opens the command guard for this ancestry',
      typeof markerPath === 'string'
      && JSON.parse(readFileSync(markerPath, 'utf8')).version === 1
      && (process.platform !== 'linux' || loopRunIsOpen(root) === true),
    );

    const persisted = persistPrimeSnapshot({
      ok: true,
      checkout: { headOid: 'a'.repeat(40) },
      snapshot: {
        kind: 'autoloop-repository-snapshot',
        sections: {
          queue: {
            complete: true,
            items: Array.from({ length: 60 }, (unused, index) => ({
              number: index + 1,
              body: 'x'.repeat(2000),
            })),
            error: null,
          },
          openIssues: { complete: false, items: [], error: { code: 'SCAN_FAILED' } },
        },
      },
    }, root);
    const printedBytes = Buffer.byteLength(
      JSON.stringify(persisted, null, 1),
      'utf8',
    );
    check(
      'stdout stays decision-sized while the persisted snapshot keeps every byte',
      persisted.snapshot === undefined
      && persisted.sections.queue.items === 60
      && persisted.sections.queue.complete === true
      && persisted.sections.openIssues.error.code === 'SCAN_FAILED'
      && printedBytes < 4096
      && JSON.parse(readFileSync(persisted.snapshotPath, 'utf8'))
        .sections.queue.items.length === 60
      && persisted.snapshotPath.endsWith(`/${'a'.repeat(40)}.snapshot.json`),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  for (const name of failures) console.error(`FAIL ${name}`);
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
    console.error(`prime: ${parsed.error}`);
    console.error('usage: prime.mjs [--json] [--scan-arg <value>]...');
    process.exit(2);
  }
  if (parsed.mode === 'self-test') process.exit(selfTest() ? 0 : 1);
  const result = primeDev({ scanArgs: parsed.scanArgs });
  const summary = result.ok === true
    ? persistPrimeSnapshot(result, result.checkout.root)
    : result;
  writeStdoutSync(
    parsed.json
      ? `${JSON.stringify(summary, null, 1)}\n`
      : `${report(summary)}\n`,
  );
  process.exit(result.ok === true ? 0 : 1);
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url))
      === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMain) main();
