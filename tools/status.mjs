#!/usr/bin/env node
// autoloop — status.mjs
//
// The run's status as one JSON object, for the status mod
// (docs/specs/SPEC-status-mod.md). This is the stable entry the mod calls:
// today it delegates to step.mjs's projection of the card's reads; a later
// producer keeps the schema and replaces the reads. It reads local files and
// two read-only git facts, never GitHub, and never writes.
//
// The band must never fall: a usage error exits 2 with one line, and any
// fault inside the projection is reported in the JSON (owned: false, error)
// with exit 0.
//
// Usage:
//   node status.mjs --json --session <id> [--root <dir>]
//   node status.mjs --fixtures > hooks/status/fixtures/projection.ts
//   node status.mjs --self-test

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATUS_SCHEMA, statusFixture, statusProjection } from './step.mjs';
import { latchDirectory, processStart, sessionOwnerPid } from './run-markers.mjs';
import { realRun } from './unit.mjs';

/** The mod's test fixtures, printed by --fixtures and held to it by the self-test. */
const FIXTURES_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'status', 'fixtures', 'projection.ts');

const USAGE = 'usage: status.mjs --json --session <id> [--root <dir>]\n       status.mjs --fixtures\n       status.mjs --self-test';

export function parseArgs(argv) {
  const out = { json: false, session: null, root: null, error: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--json') { out.json = true; continue; }
    if (flag !== '--session' && flag !== '--root') return { ...out, error: `unknown argument ${flag}` };
    const value = argv[index + 1];
    if (value === undefined || value === '') return { ...out, error: `${flag} needs a value` };
    out[flag.slice(2)] = value;
    index += 1;
  }
  if (!out.json) return { ...out, error: '--json is the only mode' };
  if (out.session === null) return { ...out, error: '--session <id> is required: ownership is the session\'s' };
  return out;
}

// Outside a repository the projection owns nothing; the root is the
// checkout the command runs in.
function checkoutRoot(cwd) {
  return realRun(cwd)('git', ['rev-parse', '--show-toplevel']).stdout || cwd;
}

export function statusJson({ session, root }) {
  try {
    return statusProjection({ root, sessionId: session });
  } catch (error) {
    const code = typeof error?.code === 'string' && error.code !== '' ? error.code : 'PROJECTION_FAILED';
    return { schema: STATUS_SCHEMA, owned: false, error: code };
  }
}

// The owned fixture, this tool's own: a checkout with one origin, this
// process's latch naming session S-1 under a scratch home, a live run marker
// naming this process, one in-flight code-review step on #412 (started at
// 10:29 on 2026-09-28, a minute before the mod's fixture clock), and the
// pinned reviewer. `call` runs this tool as a child under that home, as the
// mod does. Shared by the self-test and --fixtures.
const STEP_STARTED_AT_MS = Date.UTC(2026, 8, 28, 10, 29);

function ownedFixture() {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'status-')));
  const home = join(scratch, 'home');
  const root = join(scratch, 'repo');
  const tool = fileURLToPath(import.meta.url);
  const call = (args, env = {}) => {
    const result = spawnSync(process.execPath, [tool, ...args], {
      cwd: root, encoding: 'utf8', timeout: 15000, env: { ...process.env, HOME: home, ...env },
    });
    let json = null;
    try {
      json = JSON.parse(result.stdout);
    } catch {
      json = null;
    }
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
  };
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 15000 }).status === 0;
  const checkout = git('init', '-q') && git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  const owner = sessionOwnerPid();
  const latches = latchDirectory(home);
  mkdirSync(latches, { recursive: true });
  writeFileSync(join(latches, `${owner}.json`), JSON.stringify({ version: 2, owner, ownerStart: processStart(owner),
    baseBranch: 'main', scope: root, latchedAtMs: 1, sessionId: 'S-1' }));
  const autoloop = join(root, '.git', 'autoloop');
  mkdirSync(join(autoloop, 'run'), { recursive: true });
  mkdirSync(join(autoloop, 'steps'), { recursive: true });
  mkdirSync(join(root, '.autoloop'), { recursive: true });
  writeFileSync(join(autoloop, 'run', 'a.json'), JSON.stringify({ version: 1, pids: [process.pid], openedAtMs: 1, baseBranch: 'main' }));
  writeFileSync(join(autoloop, 'steps', '412.json'), JSON.stringify({ issue: 412, decisions: 1, steps: [{ step: '08-code-review',
    stepId: 's', dispatchId: 'd', round: 'fix-2', model: 'gpt-6-astra', role: 'code-review', startedAtMs: STEP_STARTED_AT_MS }] }));
  writeFileSync(join(autoloop, 'models.json'), JSON.stringify({ version: 1, models: { 'code-review': { model: 'gpt-6-astra' } } }));
  const config = (ui) => writeFileSync(join(root, '.autoloop', 'config.json'),
    JSON.stringify({ version: '0.28.0', baseBranch: 'main', gate: { command: 'npm test' }, ...(ui === undefined ? {} : { ui }) }));
  return { scratch, autoloop, checkout, call, config, dispose: () => rmSync(scratch, { recursive: true, force: true }) };
}

// The mod's fixtures (hooks/status/fixtures/projection.ts), each one stdout
// of this producer: the owned fixture through this tool as a child, and the
// run fixture of step.mjs's self-test (statusFixture) projected in process
// with the issues each case names. Printed under UTC, so the file is the
// same wherever it is printed.
const RUN_CASES = Object.freeze({
  RUN: (runIssues) => runIssues,
  FALLBACK: (runIssues) => runIssues.filter((number) => number !== 412),
  REPLAN: () => [416, 422],
  OPEN_FINDINGS: () => [416, 419],
  WAITING: () => [414, 415],
  IDLE_DELIVERED: () => [416, 424],
  IDLE: () => [420],
  BLOCKED_THREE: () => [412, 417, 418, 424],
  WAITS: () => [414, 415, 426, 427],
});

export function fixturesText() {
  process.env.TZ = 'UTC';
  const lines = [];
  const owned = ownedFixture();
  try {
    if (!owned.checkout) throw new Error('the owned fixture has no checkout');
    const capture = (name, args) => {
      const result = owned.call(args);
      if (result.status !== 0) throw new Error(`${name}: ${result.stderr}`);
      lines.push(`export const ${name} = ${JSON.stringify(result.stdout.trimEnd())};`);
    };
    capture('OWNED', ['--json', '--session', 'S-1']);
    capture('UNOWNED', ['--json', '--session', 'S-2']);
    owned.config({ status: false });
    capture('DISABLED', ['--json', '--session', 'S-1']);
  } finally {
    owned.dispose();
  }
  const fixture = statusFixture((hh, mm) => Date.UTC(2026, 8, 28, hh, mm));
  try {
    fixture.latch({});
    for (const [name, issues] of Object.entries(RUN_CASES)) {
      fixture.write(issues(fixture.runIssues));
      lines.push(`export const ${name} = ${JSON.stringify(JSON.stringify(fixture.project()))};`);
    }
  } finally {
    fixture.dispose();
  }
  return [
    '// The projection as tools/status.mjs prints it: `node tools/status.mjs',
    '// --fixtures > hooks/status/fixtures/projection.ts`, held to this file by',
    '// its self-test. Not hand-written: each export is one projection as the',
    '// producer prints it, so the tests parse what the producer prints.',
    '//',
    '// OWNED, UNOWNED and DISABLED come from the owned fixture the self-test',
    '// builds (a latch for session S-1, a live run marker, one in-flight',
    '// code-review step on #412, no snapshot; DISABLED with ui.status false).',
    '//',
    '// The rest come from step.mjs\'s projection fixture (statusFixture: the',
    '// clock at 10:30 on 2026-09-28, a snapshot scanned at 10:10, one step',
    '// record per fact) with the issues each case names. RUN is the whole run',
    '// (#412 in a fix round, six units that need a human, #430 blocked with no',
    '// record); FALLBACK drops #412 so the returned simplify step on its',
    '// fallback model is the worked unit; REPLAN and OPEN_FINDINGS hold one',
    '// returned review round each beside a delivered unit; WAITING holds two',
    '// waiting units and no worked unit; IDLE_DELIVERED holds a delivered unit',
    '// and an authorization; IDLE holds one staged plan; BLOCKED_THREE holds',
    '// #412 in flight beside one unit per needs-you kind (a block, a decide, an',
    '// authorize with its PR); WAITS holds one waiting unit per wait kind.',
    ...lines, ''].join('\n');
}

function selfTest() {
  const failures = [];
  const cases = [];
  const check = (name, passed) => {
    cases.push(name);
    if (!passed) failures.push(name);
  };
  const owned = ownedFixture();
  const { autoloop, call } = owned;
  try {
    check('a fixture checkout exists', owned.checkout);
    check('no --session is a usage error', (() => {
      const result = call(['--json']);
      return result.status === 2 && result.stdout === '' && result.stderr.split('\n')[0].includes('--session');
    })());
    check('an unknown argument is a usage error', call(['--json', '--session', 'S', '--colour']).status === 2);
    check('a session the latch does not name owns no run: owned false, nothing else', (() => {
      const result = call(['--json', '--session', 'S-2']);
      return result.status === 0 && result.stdout === `${JSON.stringify({ schema: 'autoloop.status/1', owned: false })}\n`;
    })());
    const projected = call(['--json', '--session', 'S-1']);
    check('the session that holds the latch and a live marker owns the run: the spec keys, its unit and the models', projected.status === 0
      && projected.json !== null && Object.keys(projected.json).join(',') === 'schema,owned,enabled,run,phases,unit,units,counts,models,log,dispatches'
      && projected.json.schema === 'autoloop.status/1' && projected.json.owned === true && projected.json.enabled === true
      && projected.json.unit?.issue === 412 && projected.json.unit.phase === 'review' && projected.json.unit.inFlight === true
      && JSON.stringify(projected.json.unit.round) === '{"kind":"fix","n":2,"budget":3}' && projected.json.unit.decisions === 1
      && projected.json.models['code-review'] === 'gpt-6-astra' && projected.json.counts.active === 1);
    check('another session, or --root outside the checkout, owns nothing',
      call(['--json', '--session', 'S-2']).json?.owned === false
      && call(['--json', '--session', 'S-1', '--root', owned.scratch]).json?.owned === false);
    // A fault past ownership (the steps directory is a file): the band
    // reads owned false with the fault's code, and the tool still exits 0.
    rmSync(join(autoloop, 'steps'), { recursive: true, force: true });
    writeFileSync(join(autoloop, 'steps'), '');
    const faulted = call(['--json', '--session', 'S-1']);
    check('a fault inside the projection is reported in the JSON with exit 0, never thrown',
      faulted.status === 0 && JSON.stringify(faulted.json) === JSON.stringify({ schema: 'autoloop.status/1', owned: false, error: 'ENOTDIR' }));
    // The mod's fixtures are this tool's own print: a hand edit, or a
    // producer change not reprinted, fails here.
    check('--fixtures prints hooks/status/fixtures/projection.ts byte for byte (regenerate: node status.mjs --fixtures > that file)', (() => {
      const printed = call(['--fixtures']);
      return printed.status === 0 && printed.stdout === readFileSync(FIXTURES_FILE, 'utf8');
    })());
    check('arguments parse', parseArgs(['--json', '--session', 'S']).error === null
      && parseArgs(['--json', '--session', 'S', '--root', '/r']).root === '/r'
      && parseArgs(['--session', 'S']).error !== null && parseArgs(['--json', '--session']).error !== null);
  } finally {
    owned.dispose();
  }
  for (const name of failures) console.error(`FAIL ${name}`);
  console.log(failures.length === 0
    ? `self-test OK (${cases.length} cases)`
    : `self-test FAILED (${failures.length}/${cases.length})`);
  return failures.length === 0;
}

function main() {
  if (process.argv[2] === '--self-test') process.exit(selfTest() ? 0 : 1);
  if (process.argv[2] === '--fixtures' && process.argv.length === 3) {
    process.stdout.write(fixturesText());
    return;
  }
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(`status: ${parsed.error}\n${USAGE}`);
    process.exit(2);
  }
  const root = parsed.root ?? checkoutRoot(process.cwd());
  process.stdout.write(`${JSON.stringify(statusJson({ session: parsed.session, root }))}\n`);
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
