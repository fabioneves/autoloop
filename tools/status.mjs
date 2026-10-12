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
//   node status.mjs --self-test

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATUS_SCHEMA, statusProjection } from './step.mjs';
import { latchDirectory, processStart, sessionOwnerPid } from './run-markers.mjs';
import { realRun } from './unit.mjs';

const USAGE = 'usage: status.mjs --json --session <id> [--root <dir>]\n       status.mjs --self-test';

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

function selfTest() {
  const failures = [];
  const cases = [];
  const check = (name, passed) => {
    cases.push(name);
    if (!passed) failures.push(name);
  };
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
  try {
    mkdirSync(home, { recursive: true });
    mkdirSync(root, { recursive: true });
    const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 15000 }).status === 0;
    check('a fixture checkout exists', git('init', '-q') && git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git'));
    check('no --session is a usage error', (() => {
      const result = call(['--json']);
      return result.status === 2 && result.stdout === '' && result.stderr.split('\n')[0].includes('--session');
    })());
    check('an unknown argument is a usage error', call(['--json', '--session', 'S', '--colour']).status === 2);
    check('a session that owns no run reads owned false, nothing else', (() => {
      const result = call(['--json', '--session', 'S-1']);
      return result.status === 0 && result.stdout === `${JSON.stringify({ schema: 'autoloop.status/1', owned: false })}\n`;
    })());
    // The owned fixture: this process's latch naming the session under the
    // scratch home, and a live marker naming this process in the checkout.
    const owner = sessionOwnerPid();
    const latches = latchDirectory(home);
    mkdirSync(latches, { recursive: true });
    writeFileSync(join(latches, `${owner}.json`), JSON.stringify({ version: 2, owner, ownerStart: processStart(owner),
      baseBranch: 'main', scope: root, latchedAtMs: 1, sessionId: 'S-1' }));
    const autoloop = join(root, '.git', 'autoloop');
    mkdirSync(join(autoloop, 'run'), { recursive: true });
    mkdirSync(join(autoloop, 'steps'), { recursive: true });
    writeFileSync(join(autoloop, 'run', 'a.json'), JSON.stringify({ version: 1, pids: [process.pid], openedAtMs: 1, baseBranch: 'main' }));
    writeFileSync(join(autoloop, 'steps', '412.json'), JSON.stringify({ issue: 412, decisions: 1, steps: [{ step: '08-code-review',
      stepId: 's', dispatchId: 'd', round: 'fix-2', model: 'gpt-6-astra', role: 'code-review', startedAtMs: Date.now() - 60_000 }] }));
    writeFileSync(join(autoloop, 'models.json'), JSON.stringify({ version: 1, models: { 'code-review': { model: 'gpt-6-astra' } } }));
    const owned = call(['--json', '--session', 'S-1']);
    check('the session that holds the latch and a live marker owns the run: the spec keys, its unit and the models', owned.status === 0
      && owned.json !== null && Object.keys(owned.json).join(',') === 'schema,owned,enabled,run,phases,unit,units,counts,models'
      && owned.json.schema === 'autoloop.status/1' && owned.json.owned === true && owned.json.enabled === true
      && owned.json.unit?.issue === 412 && owned.json.unit.phase === 'review' && owned.json.unit.inFlight === true
      && JSON.stringify(owned.json.unit.round) === '{"kind":"fix","n":2,"budget":3}' && owned.json.unit.decisions === 1
      && owned.json.models['code-review'] === 'gpt-6-astra' && owned.json.counts.active === 1);
    check('another session, or --root outside the checkout, owns nothing',
      call(['--json', '--session', 'S-2']).json?.owned === false
      && call(['--json', '--session', 'S-1', '--root', scratch]).json?.owned === false);
    // A fault past ownership (the steps directory is a file): the band
    // reads owned false with the fault's code, and the tool still exits 0.
    rmSync(join(autoloop, 'steps'), { recursive: true, force: true });
    writeFileSync(join(autoloop, 'steps'), '');
    const faulted = call(['--json', '--session', 'S-1']);
    check('a fault inside the projection is reported in the JSON with exit 0, never thrown',
      faulted.status === 0 && JSON.stringify(faulted.json) === JSON.stringify({ schema: 'autoloop.status/1', owned: false, error: 'ENOTDIR' }));
    check('arguments parse', parseArgs(['--json', '--session', 'S']).error === null
      && parseArgs(['--json', '--session', 'S', '--root', '/r']).root === '/r'
      && parseArgs(['--session', 'S']).error !== null && parseArgs(['--json', '--session']).error !== null);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  for (const name of failures) console.error(`FAIL ${name}`);
  console.log(failures.length === 0
    ? `self-test OK (${cases.length} cases)`
    : `self-test FAILED (${failures.length}/${cases.length})`);
  return failures.length === 0;
}

function main() {
  if (process.argv[2] === '--self-test') process.exit(selfTest() ? 0 : 1);
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
