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
//   node tools/agentic/prime.mjs --close-run
//   node tools/agentic/prime.mjs --park <reason> --minutes <1..720>
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
  loopRunIsLive,
  loopRunIsOpen,
  ownRunMarkers,
  runMarkerDirectory,
} from './command-guard.mjs';
import { extractConfig, validateProjectConfig } from './config-contract.mjs';
import { hashValue } from './review-contract.mjs';
import { snapshotExecutionRepository } from './checkout-contract.mjs';
import { SNAPSHOT_SECTIONS, writeStdoutSync } from './snapshot-contract.mjs';
import { liftWaits, postDigest, realRun, triageBlocks } from './unit.mjs';

// Bumped by every release together with the other version literals; the
// release verifier requires this literal to equal VERSION.
const AUTOLOOP_VERSION = '0.52.0';

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

export function primeDev({ cwd = process.cwd(), scanArgs = [], lift = liftWaits, triage = triageBlocks } = {}) {
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
  clearRunParks(root);
  const runMarker = writeRunMarker(root);
  // Before the scan, so a unit whose wait just cleared is already eligible in
  // the snapshot this run chooses from.
  const waits = lift({ base: config.baseBranch, run: realRun(root) });
  // Same reasoning: a unit a human just answered is eligible in this snapshot.
  const blocks = triage({ run: realRun(root) });

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
    config: configSummary(config),
    base,
    runMarker,
    waits,
    blocks,
    timings: { scanMs, primeMs: Date.now() - PROCESS_START_MS },
    snapshot,
  };
}

// The five summary fields are what a run decides with. `projectConfig` and
// `fingerprint` are what it must not hand-derive: the review contract compares
// a round's `configFingerprint` against the hash of the projectConfig the caller
// supplies, so a run needs both, they have to be the same object, and the
// canonicalization is exact — `jq -S -c -j`, keys sorted recursively, compact,
// no trailing newline. A live run lost a round computing it over pretty-printed
// output, and two more read STATE off `origin/<base>` by hand because the
// summary did not carry the config at all. Both are prime's answer to give.
//
// `hashValue` is imported from the contract that compares it, never copied.
export function configSummary(config) {
  return {
    version: config.version,
    baseBranch: config.baseBranch,
    mergePolicy: config.merge.policy,
    gateCommand: config.gate.command,
    checklistPath: config.review.checklistPath,
    fingerprint: hashValue(config),
    projectConfig: config,
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

// The counterpart to the marker prime writes: the run says, once, that it is
// done taking work. Only the run can say it — a hook can see that a session is
// idle but not whether that is a finished run or a run that went dark, and the
// live 0.49.58 session that stopped with thirteen eligible units is what the
// distinction costs when it is left to inference.
//
// The marker itself stays exactly where it is, pids intact: a closed run keeps
// issuing commands, and disarming the command guard at the close would trade
// this defect for a worse one.
export function closeRunMarkers(root = process.cwd(), now = new Date()) {
  const closed = [];
  for (const { path, marker } of ownRunMarkers(root)) {
    if (marker.closedAt !== undefined) continue;
    try {
      writeFileSync(path, `${JSON.stringify({ ...marker, closedAt: now.toISOString() })}\n`);
      closed.push(path);
    } catch (error) {
      return { ok: false, closed, error: { code: 'RUN_MARKER_UNWRITABLE', message: String(error?.message ?? error) } };
    }
  }
  return { ok: true, closed };
}

// A usage limit or a red base is a reason to WAIT, and the run used to have no
// way to say so: the Stop hook saw an idle live run with a queue, refused the
// turn, and the only escape it offered was `--close-run`, so every such park
// ended the run. A park is a bounded promise to come back — the reason and an
// expiry, stamped on the live markers — and the hook honours it only until then.
export const PARK_MAX_MINUTES = 720;

export function parkRunMarkers(root = process.cwd(), reason, minutes, now = new Date()) {
  const until = new Date(now.getTime() + minutes * 60_000).toISOString();
  const parked = [];
  for (const { path, marker } of ownRunMarkers(root)) {
    if (marker.closedAt !== undefined) continue;
    try {
      writeFileSync(path, `${JSON.stringify({ ...marker, park: { reason, until } })}\n`);
      parked.push(path);
    } catch (error) {
      return { ok: false, parked, error: { code: 'RUN_MARKER_UNWRITABLE', message: String(error?.message ?? error) } };
    }
  }
  if (parked.length === 0) {
    return { ok: false, parked, error: { code: 'NO_LIVE_RUN', message: 'no live run marker belongs to this session' } };
  }
  return { ok: true, parked, until };
}

// A re-prime is the run waking up: whatever park an earlier marker of this
// session carries is spent, and leaving it would let a run that parks for 12h,
// wakes early, and then goes dark read as parked.
export function clearRunParks(root = process.cwd()) {
  for (const { path, marker } of ownRunMarkers(root)) {
    if (marker.park === undefined) continue;
    const { park, ...rest } = marker;
    try {
      writeFileSync(path, `${JSON.stringify(rest)}\n`);
    } catch { /* an unwritable marker keeps its park until expiry — never worse than today */ }
  }
}

// A close or a park is when a human reads the run, so both post the decision
// digest themselves rather than trusting the closing prose to. A failed digest
// is reported beside the outcome and never fails it.
export function withDigest(outcome, post) {
  if (outcome.ok !== true) return outcome;
  let digest;
  try {
    digest = post();
  } catch (error) {
    digest = { ok: false, error: String(error?.message ?? error) };
  }
  return { ...outcome, digest };
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

export function waitLines(waits) {
  return [
    ...(waits?.lifted ?? []).map((entry) => `lifted: #${entry.number} (${entry.reason})`),
    ...(waits?.waiting ?? []).map((entry) => `waiting: #${entry.number} (${entry.reason})`),
    ...(waits?.errors ?? []).map((error) => `wait-lift error: ${error}`),
  ];
}

export function blockLines(blocks) {
  return [
    ...(blocks?.resumed ?? []).map((entry) => `resumed: #${entry.number} (@${entry.by}: ${entry.answer}) — take it first`),
    ...(blocks?.waiting ?? []).map((entry) => `blocked: #${entry.number} — ${entry.question}`),
    ...(blocks?.held ?? []).map((entry) => `held: #${entry.number} (${entry.reason})`),
    ...(blocks?.errors ?? []).map((error) => `block-triage error: ${error}`),
  ];
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
    ...waitLines(summary.waits),
    ...blockLines(summary.blocks),
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
  if (args.length === 1 && args[0] === '--close-run') {
    return { ...parsed, mode: 'close-run' };
  }
  if (args[0] === '--park') {
    const [, reason, flag, value] = args;
    const minutes = Number(value);
    if (args.length !== 4 || typeof reason !== 'string' || reason.trim() === '' || flag !== '--minutes') {
      return { ...parsed, error: '--park: expected --park <reason> --minutes <n>' };
    }
    if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > PARK_MAX_MINUTES) {
      return { ...parsed, error: `--minutes: expected a whole number 1..${PARK_MAX_MINUTES}` };
    }
    return { ...parsed, mode: 'park', park: { reason: reason.trim(), minutes } };
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
    version: '0.27.0',
    baseBranch: 'main',
    gate: { command: 'true', quickCommand: null, setupCommand: null },
    merge: { policy: 'manual' },
    tracker: { provider: 'none' },
    review: { checklistPath: 'docs/agentic/checklist.md' },
    caps: {
      gateRetriesPerUnit: 2,
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
    'argument parsing accepts only --json, repeated --scan-arg, and a lone --close-run',
    parseArgs([]).error === null
    && parseArgs(['--json']).json === true
    && parseArgs(['--close-run']).mode === 'close-run'
    && parseArgs(['--close-run', '--json']).error !== null
    && JSON.stringify(parseArgs(['--scan-arg', '--pr', '--scan-arg', '7']).scanArgs)
      === JSON.stringify(['--pr', '7'])
    && parseArgs(['--scan-arg']).error !== null
    && parseArgs(['--measure']).error !== null,
  );

  check(
    'a park needs a reason and whole minutes within 1..720',
    parseArgs(['--park', 'usage limit', '--minutes', '30']).mode === 'park'
    && parseArgs(['--park', 'usage limit', '--minutes', '30']).park.reason === 'usage limit'
    && parseArgs(['--park', 'usage limit', '--minutes', '30']).park.minutes === 30
    && parseArgs(['--park', 'x', '--minutes', '720']).error === null
    && parseArgs(['--park', 'x', '--minutes', '721']).error !== null
    && parseArgs(['--park', 'x', '--minutes', '0']).error !== null
    && parseArgs(['--park', 'x', '--minutes', '1.5']).error !== null
    && parseArgs(['--park', '', '--minutes', '5']).error !== null
    && parseArgs(['--park', 'x']).error !== null
    && parseArgs(['--park', 'x', '--minutes', '5', '--json']).error !== null,
  );

  const summary = configSummary(fixtureConfig());
  check(
    'the config block carries the validated ProjectConfig and its review fingerprint',
    summary.fingerprint === hashValue(fixtureConfig())
    && /^[0-9a-f]{64}$/.test(summary.fingerprint)
    && summary.projectConfig.caps.codeReviewRoundsPerUnit === 5
    && summary.mergePolicy === 'manual'
    // Key ORDER must not change the fingerprint: canonicalization sorts
    // recursively, which is the whole reason a hash taken over raw STATE text
    // drifts from the one the contract computes.
    && configSummary(Object.fromEntries(
      Object.entries(fixtureConfig()).reverse(),
    )).fingerprint === summary.fingerprint,
  );

  check(
    'lifted and still-waiting units are printed, one line each',
    waitLines({
      lifted: [{ number: 10, reason: '#4 is closed' }],
      waiting: [{ number: 13, reason: 'no parseable waiting marker' }],
      errors: ['list: offline'],
    }).join('|') === 'lifted: #10 (#4 is closed)|waiting: #13 (no parseable waiting marker)|wait-lift error: list: offline'
    && waitLines(undefined).length === 0,
  );

  check(
    'resumed, still-blocked and held units are printed, one line each',
    blockLines({
      resumed: [{ number: 7, by: 'owner', answer: '128 chars, "Unnamed device"' }],
      waiting: [{ number: 8, question: 'What length?' }],
      held: [{ number: 9, reason: 'no loop marker' }],
      errors: ['list: offline'],
    }).join('|') === 'resumed: #7 (@owner: 128 chars, "Unnamed device") — take it first'
      + '|blocked: #8 — What length?|held: #9 (no loop marker)|block-triage error: list: offline'
    && blockLines(undefined).length === 0,
  );

  check(
    'a close or park carries the digest, and a failing digest never fails it',
    withDigest({ ok: true, closed: [] }, () => ({ ok: true, issue: 9, rows: [] })).digest.issue === 9
    && withDigest({ ok: true }, () => { throw new Error('offline'); }).ok === true
    && withDigest({ ok: true }, () => { throw new Error('offline'); }).digest.ok === false
    && withDigest({ ok: false }, () => { throw new Error('never called'); }).digest === undefined,
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

    const parkedAt = new Date('2026-01-01T12:00:00Z');
    const parked = parkRunMarkers(root, 'usage limit on claude-opus-5-5', 45, parkedAt);
    const parkedMarker = JSON.parse(readFileSync(markerPath, 'utf8'));
    check(
      'a timed park stamps reason and expiry on the live marker and keeps the run live',
      parked.ok === true
      && parked.parked.includes(markerPath)
      && parkedMarker.park?.reason === 'usage limit on claude-opus-5-5'
      && parkedMarker.park?.until === '2026-01-01T12:45:00.000Z'
      && parkedMarker.closedAt === undefined
      && (process.platform !== 'linux' || loopRunIsLive(root) === true),
    );

    clearRunParks(root);
    check(
      'a re-prime clears a spent park from this session\'s markers',
      JSON.parse(readFileSync(markerPath, 'utf8')).park === undefined
      && JSON.parse(readFileSync(markerPath, 'utf8')).version === 1,
    );

    const closed = closeRunMarkers(root);
    const reclosed = closeRunMarkers(root);
    check(
      'closing the run stamps closedAt, ends liveness, and leaves the guard armed',
      closed.ok === true
      && closed.closed.includes(markerPath)
      && typeof JSON.parse(readFileSync(markerPath, 'utf8')).closedAt === 'string'
      && JSON.parse(readFileSync(markerPath, 'utf8')).version === 1
      && (process.platform !== 'linux' || loopRunIsLive(root) === false)
      && (process.platform !== 'linux' || loopRunIsOpen(root) === true)
      && reclosed.ok === true
      && reclosed.closed.length === 0,
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
    console.error('usage: prime.mjs [--json] [--scan-arg <value>]... | --close-run | --park <reason> --minutes <n> | --self-test');
    process.exit(2);
  }
  if (parsed.mode === 'self-test') process.exit(selfTest() ? 0 : 1);
  const digest = () => postDigest({ run: realRun(process.cwd()) });
  if (parsed.mode === 'park') {
    const outcome = withDigest(
      parkRunMarkers(process.cwd(), parsed.park.reason, parsed.park.minutes),
      digest,
    );
    writeStdoutSync(`${JSON.stringify(outcome, null, 1)}\n`);
    process.exit(outcome.ok === true ? 0 : 1);
  }
  if (parsed.mode === 'close-run') {
    const outcome = withDigest(closeRunMarkers(), digest);
    writeStdoutSync(`${JSON.stringify(outcome, null, 1)}\n`);
    process.exit(outcome.ok === true ? 0 : 1);
  }
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
