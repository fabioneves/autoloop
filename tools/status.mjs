#!/usr/bin/env node
// autoloop — status.mjs
//
// The run's status as one JSON object, for the status mod
// (docs/specs/SPEC-status-mod.md). This is the stable entry the mod calls:
// Legacy reads delegate to step.mjs. Daemon reads use verified viewer bindings
// and the authoritative checkpoint. Host-admitted mutations attach/disconnect
// viewers or submit durable controls; they never change worker ownership.
// Read faults remain JSON errors with exit 0, so a display keeps its last good
// state. Mutations use the autoloop.loop/1 envelope and typed refusal codes.
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
import { resolveCommonDir, takeControls, writeControl } from './events-contract.mjs';
import { admitHostInvocation } from './loop-admission.mjs';
import { parseLoopArgs, prepareLoopCommand } from './loop.mjs';
import { readCheckpoint, resolveRepository, SchedulerError, submitControl } from './scheduler-contract.mjs';
import { attachViewer, daemonProjection, directViewerHost, discoverViewer, disconnectViewer, endViewer,
  prepareViewerCommand, readViewer } from './loop-viewer.mjs';

/** The mod's test fixtures, printed by --fixtures and held to it by the self-test. */
const FIXTURES_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'status', 'fixtures', 'projection.ts');

const USAGE = 'usage: status.mjs --json --session <id> [--root <dir>] [--log <n>]\n'
  + '       status.mjs --control --session <id> --kind <pause|unpause|cancel|answer|merge|label> [--pr <n>] [--issue <n>] [--dispatch <id>] [--text <t>] [--root <dir>]\n'
  + '       status.mjs --discover --session <id> --root <dir>\n'
  + '       status.mjs --attach --session <id> --run <uuid> --root <dir> --host-request\n'
  + '       status.mjs --disconnect --session <id> --root <dir> --host-request\n'
  + '       status.mjs --control --session <id> --run <uuid> --request <uuid> --kind <pause|resume|stop|stop-now> --root <dir> --host-request\n'
  + '       status.mjs --fixtures\n       status.mjs --self-test';
export const LOG_MAX = 2000;
const NUMBERS = new Set(['--pr', '--issue']);

export function parseArgs(argv) {
  const out = { json: false, control: false, discover: false, attach: false, disconnect: false, viewerEnded: false, hostRequest: false,
    session: null, root: null, run: null, request: null, generation: null, log: null, kind: null, pr: null, issue: null, dispatch: null, text: null, error: null };
  const valued = ['--session', '--root', '--run', '--request', '--generation', '--log', '--kind', '--pr', '--issue', '--dispatch', '--text'];
  const modes = { '--json': 'json', '--control': 'control', '--discover': 'discover', '--attach': 'attach',
    '--disconnect': 'disconnect', '--viewer-ended': 'viewerEnded', '--host-request': 'hostRequest' };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (seen.has(flag)) return { ...out, error: `repeated argument ${flag}` };
    seen.add(flag);
    if (flag in modes) { out[modes[flag]] = true; continue; }
    if (!valued.includes(flag)) return { ...out, error: `unknown argument ${flag}` };
    const value = argv[index + 1];
    if (value === undefined || value === '' || value.startsWith('--')) return { ...out, error: `${flag} needs a value` };
    if (flag === '--generation') {
      if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(Number(value))) return { ...out, error: '--generation needs a positive integer' };
      out.generation = Number(value);
    } else if (flag === '--log') {
      // The Log tab asks for the whole run; the band keeps the default.
      if (!/^[1-9]\d{0,3}$/u.test(value) || Number(value) > LOG_MAX) return { ...out, error: `--log: a whole number 1..${LOG_MAX}` };
      out.log = Number(value);
    } else if (NUMBERS.has(flag)) {
      if (!/^[1-9]\d{0,8}$/u.test(value)) return { ...out, error: `${flag}: a positive number` };
      out[flag.slice(2)] = Number(value);
    } else out[flag.slice(2)] = value;
    index += 1;
  }
  if (['json', 'control', 'discover', 'attach', 'disconnect', 'viewerEnded'].filter((key) => out[key]).length !== 1)
    return { ...out, error: '--json, --control, --discover, --attach, --disconnect or --viewer-ended: choose one' };
  if (out.session === null) return { ...out, error: '--session <id> is required: ownership is the session\'s' };
  if (out.control && out.kind === null) return { ...out, error: '--control needs --kind' };
  if ((out.attach || out.disconnect) && !out.hostRequest) return { ...out, error: 'viewer mutations require --host-request' };
  if (out.attach && out.run === null) return { ...out, error: '--attach needs --run' };
  if (out.hostRequest && !(out.attach || out.disconnect || (out.control && out.run !== null))) return { ...out, error: '--host-request requires a daemon mutation' };
  if (out.control && out.run !== null && (!out.hostRequest || out.request === null)) return { ...out, error: 'daemon controls need --host-request and --request' };
  if (!(out.control || out.attach) && (out.run !== null || out.request !== null || out.generation !== null)) return { ...out, error: 'this operation cannot select a run or request' };
  if (!out.control && [out.kind, out.pr, out.issue, out.dispatch, out.text].some((value) => value !== null)) return { ...out, error: 'control fields require --control' };
  if (!out.json && out.log !== null) return { ...out, error: '--log requires --json' };
  return out;
}

// The operator's control, written by the producer so the mod never holds a
// path: the session must own the run (the same predicate as the projection),
// the control is validated and written atomically by the contract, and the
// answer says the file's name. Never throws.
export function controlJson({ session, root, kind, pr, issue, dispatch, text, nowMs = Date.now() }) {
  try {
    const projection = statusProjection({ root, sessionId: session });
    if (projection.owned !== true) return { ok: false, error: 'this session owns no run' };
    const commonDir = resolveCommonDir(root);
    if (commonDir === null) return { ok: false, error: 'no common git directory' };
    const control = { v: 1, at: nowMs, kind, by: 'ui', session };
    for (const [name, value] of Object.entries({ pr, issue, dispatch, text })) if (value !== null && value !== undefined) control[name] = value;
    const written = writeControl(commonDir, control);
    return written.ok ? { ok: true, name: written.name, kind } : { ok: false, error: written.error };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

// Outside a repository the projection owns nothing; the root is the
// checkout the command runs in.
function checkoutRoot(cwd) {
  return realRun(cwd)('git', ['rev-parse', '--show-toplevel']).stdout || cwd;
}

export function statusJson({ session, root, log = null }) {
  try {
    let repository = null;
    try { repository = resolveRepository(root); }
    catch (error) { if (error.code !== 'REPOSITORY_INVALID') throw error; }
    const viewer = repository === null ? null : readViewer(repository, session);
    if (viewer !== null) return daemonProjection(repository, readCheckpoint(repository, viewer.runId), viewer,
      log === null ? {} : { logLimit: log });
    return statusProjection({ root, sessionId: session, ...(log === null ? {} : { logLimit: log }) });
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
// Each case names the issues it holds and, past them, the fixture's write
// options (a paused marker, a refused control, a second running dispatch).
const RUN_CASES = Object.freeze({
  RUN: (runIssues) => [runIssues],
  FALLBACK: (runIssues) => [runIssues.filter((number) => number !== 412)],
  REPLAN: () => [[416, 422]],
  OPEN_FINDINGS: () => [[416, 419]],
  WAITING: () => [[414, 415]],
  IDLE_DELIVERED: () => [[416, 424]],
  IDLE: () => [[420]],
  BLOCKED_THREE: () => [[412, 417, 418, 424]],
  WAITS: () => [[414, 415, 426, 427]],
  PAUSED: (runIssues) => [runIssues, { paused: true }],
  REFUSED: (runIssues) => [runIssues, { refused: true }],
  TWO_DISPATCHES: (runIssues) => [runIssues, { secondDispatch: true }],
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
    for (const [name, held] of Object.entries(RUN_CASES)) {
      fixture.write(...held(fixture.runIssues));
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
    '// authorize with its PR); WAITS holds one waiting unit per wait kind;',
    '// PAUSED is RUN with the pause marker; REFUSED is RUN with one refused',
    '// merge control; TWO_DISPATCHES is RUN with #421\'s fix dispatch running',
    '// beside #412\'s review.',
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
      && projected.json !== null && Object.keys(projected.json).join(',') === 'schema,owned,enabled,run,phases,unit,units,counts,models,log,dispatches,controls'
      && projected.json.schema === 'autoloop.status/1' && projected.json.owned === true && projected.json.enabled === true
      && projected.json.unit?.issue === 412 && projected.json.unit.phase === 'review' && projected.json.unit.inFlight === true
      && JSON.stringify(projected.json.unit.round) === '{"kind":"fix","n":2,"budget":3}' && projected.json.unit.decisions === 1
      && projected.json.models['code-review'] === 'gpt-6-astra' && projected.json.counts.active === 1);
    check('another session, or --root outside the checkout, owns nothing',
      call(['--json', '--session', 'S-2']).json?.owned === false
      && call(['--json', '--session', 'S-1', '--root', owned.scratch]).json?.owned === false);
    check('--control writes one validated control for the owning session and none for another', (() => {
      const written = owned.call(['--control', '--session', 'S-1', '--kind', 'answer', '--issue', '412', '--text', 'use the spec']);
      const foreign = owned.call(['--control', '--session', 'S-2', '--kind', 'pause']);
      const bad = owned.call(['--control', '--session', 'S-1', '--kind', 'merge']);
      const json = JSON.parse(written.stdout);
      const taken = takeControls(dirname(owned.autoloop), ['answer', 'pause']);
      return written.status === 0 && json.ok === true && typeof json.name === 'string'
        && JSON.parse(foreign.stdout).ok === false && JSON.parse(bad.stdout).ok === false
        && taken.length === 1 && taken[0].control.kind === 'answer' && taken[0].control.issue === 412 && taken[0].control.text === 'use the spec'
        && taken[0].control.by === 'ui' && taken[0].control.session === 'S-1';
    })());
    check('--control --kind cancel carries the dispatch and the issue beside it (SPEC-events item 6)', (() => {
      const written = owned.call(['--control', '--session', 'S-1', '--kind', 'cancel', '--dispatch', 'd', '--issue', '412']);
      const taken = takeControls(dirname(owned.autoloop), ['cancel']);
      return written.status === 0 && JSON.parse(written.stdout).ok === true
        && taken.length === 1 && taken[0].control.kind === 'cancel' && taken[0].control.dispatch === 'd' && taken[0].control.issue === 412;
    })());
    check('--log sets the log length of the printed projection', (() => {
      const printed = owned.call(['--json', '--session', 'S-1', '--log', '1']);
      const json = JSON.parse(printed.stdout);
      return printed.status === 0 && Array.isArray(json.log) && json.log.length <= 1;
    })());
    // A fault past ownership (the steps directory is a file): the band
    // reads owned false with the fault's code, and the tool still exits 0.
    rmSync(join(autoloop, 'steps'), { recursive: true, force: true });
    writeFileSync(join(autoloop, 'steps'), '');
    const faulted = call(['--json', '--session', 'S-1']);
    check('a fault inside the projection is reported in the JSON with exit 0, never thrown',
      faulted.status === 0 && JSON.stringify(faulted.json) === JSON.stringify({ schema: 'autoloop.status/1', owned: false, error: 'ENOTDIR' }));
    // The mod's fixtures are this tool's own print: a hand edit, or a
    // producer change not reprinted, fails here.
    const printed = call(['--fixtures']);
    check('--fixtures prints hooks/status/fixtures/projection.ts byte for byte (regenerate: node status.mjs --fixtures > that file)',
      printed.status === 0 && printed.stdout === readFileSync(FIXTURES_FILE, 'utf8'));
    check('the PAUSED, REFUSED and TWO_DISPATCHES fixtures carry the paused run, one refused merge and two running dispatches', (() => {
      const exported = Object.fromEntries([...printed.stdout.matchAll(/^export const (\w+) = (".*");$/gmu)]
        .map(([, name, json]) => [name, JSON.parse(JSON.parse(json))]));
      const { RUN, PAUSED, REFUSED, TWO_DISPATCHES } = exported;
      return RUN?.run.paused === false && RUN.controls.refused.length === 0 && RUN.dispatches.length === 1
        && PAUSED?.run.paused === true && PAUSED.unit?.issue === 412
        && REFUSED?.controls.refused.length === 1 && REFUSED.controls.refused[0].kind === 'merge' && REFUSED.controls.refused[0].pr === 700
        && TWO_DISPATCHES?.dispatches.length === 2 && TWO_DISPATCHES.dispatches.every((entry) => entry.state === 'running' && entry.liveFile !== null)
        && TWO_DISPATCHES.dispatches.some((entry) => entry.dispatch === 'd421' && entry.issue === 421);
    })());
    check('arguments parse', parseArgs(['--json', '--session', 'S']).error === null
      && parseArgs(['--json', '--session', 'S', '--root', '/r']).root === '/r'
      && parseArgs(['--json', '--session', 'S', '--log', '500']).log === 500 && parseArgs(['--json', '--session', 'S']).log === null
      && parseArgs(['--json', '--session', 'S', '--log', '0']).error !== null && parseArgs(['--json', '--session', 'S', '--log', '2001']).error !== null
      && parseArgs(['--control', '--session', 'S', '--kind', 'pause']).control === true && parseArgs(['--control', '--session', 'S']).error !== null
      && parseArgs(['--json', '--control', '--session', 'S']).error !== null
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

// All status mutations normalize their own entrypoint, then consume host admission.
export function prepareStatusCommand(options) {
  const root = options.root;
  if (options.attach || options.disconnect) return prepareViewerCommand({ operation: options.attach ? 'attach' : 'disconnect',
    root, sessionId: options.session, runId: options.run, requestId: options.request, generation: options.generation });
  const operation = options.kind === 'unpause' ? 'resume' : options.kind;
  if (!['pause', 'resume', 'stop', 'stop-now'].includes(operation)) {
    throw new SchedulerError('UNSUPPORTED_ACTION', 'Unit actions are not available in this module.');
  }
  if ([options.pr, options.issue, options.dispatch, options.text].some((value) => value !== null)) {
    throw new SchedulerError('INVALID_INPUT', 'Run controls have no payload.');
  }
  const argv = [operation === 'stop-now' ? 'stop' : operation, ...(operation === 'stop-now' ? ['--now'] : []),
    '--root', root, '--run', options.run, '--request', options.request, '--host-request', '--json',
    ...(options.generation === null ? [] : ['--generation', String(options.generation)])];
  const prepared = prepareLoopCommand(parseLoopArgs(argv));
  return { ...prepared, command: { ...prepared.command, entrypoint: realpathSync(fileURLToPath(import.meta.url)) } };
}
export async function executeStatusCommand(options, envelope = null) {
  const repository = resolveRepository(options.root);
  if (options.discover) return discoverViewer(repository);
  if (options.viewerEnded) return endViewer(repository, options.session, directViewerHost());
  const prepared = prepareStatusCommand(options);
  if (envelope?.sessionId !== options.session) throw new SchedulerError('HOST_AUTH_REQUIRED', 'The host session does not match.');
  const actor = await admitHostInvocation(prepared.command, envelope);
  if (options.attach) return attachViewer(repository, actor, prepared.command.runId, prepared.command.generation, envelope.issuedAt);
  if (options.disconnect) return disconnectViewer(repository, actor);
  const viewer = readViewer(repository, options.session);
  if (viewer?.runId !== prepared.command.runId) throw new SchedulerError('HOST_AUTH_REQUIRED', 'This viewer is not attached to the target run.');
  return { ...submitControl(repository, actor, { schema: 'autoloop.control/2', requestId: prepared.command.requestId,
    runId: prepared.command.runId, kind: prepared.command.operation, target: { type: 'run', generation: prepared.command.generation },
    payload: {}, submittedAt: Date.now() }), accepted: true };
}
async function main() {
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
  if (parsed.discover || parsed.attach || parsed.disconnect || parsed.viewerEnded || parsed.hostRequest) {
    try {
      let envelope = null;
      if (parsed.hostRequest) {
        let text = '';
        for await (const chunk of process.stdin) text += chunk;
        try { envelope = JSON.parse(text); }
        catch { throw new SchedulerError('HOST_AUTH_REQUIRED', 'The host envelope is invalid.'); }
      }
      const data = await executeStatusCommand({ ...parsed, root }, envelope);
      process.stdout.write(`${JSON.stringify({ schema: 'autoloop.loop/1', ok: true, data })}\n`);
    } catch (error) {
      const code = error instanceof SchedulerError ? error.code : 'STATE_IO_FAILED';
      process.stdout.write(`${JSON.stringify({ schema: 'autoloop.loop/1', ok: false,
        error: { code, message: error instanceof SchedulerError ? error.message : 'The viewer operation failed.' } })}\n`);
      process.exitCode = code === 'INVALID_INPUT' ? 2 : ['STATE_INVALID', 'STATE_IO_FAILED', 'RECOVERY_REQUIRED'].includes(code) ? 5 : 3;
    }
    return;
  }
  if (parsed.control) {
    process.stdout.write(`${JSON.stringify(controlJson({ ...parsed, root }))}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(statusJson({ session: parsed.session, root, log: parsed.log }))}\n`);
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMain) await main();
