#!/usr/bin/env node
// Operator admission for the loop backend. The mod records a user gesture and
// issues the one-use handoff outside model tools. This module verifies it; it
// does not expose a receipt issuer or claim same-user process isolation.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync, constants, copyFileSync, createReadStream, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isatty } from 'node:tty';
import { fileURLToPath } from 'node:url';
import { ancestorChain, isClaudeProcess, procEntry } from './run-markers.mjs';
import {
  readCurrentCheckpoint, readProcessIdentity, resolveRepository, schedulerDigest, SchedulerError,
} from './scheduler-contract.mjs';

export const HOST_INVOCATION_SCHEMA = 'autoloop.host-invocation/1';
export const LOOP_COMMAND_SCHEMA = 'autoloop.loop-command/1';
export const HOST_INVOCATION_MAX_AGE_MS = 10_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH_RE = /^[0-9a-f]{64}$/u;
const COMMAND_KEYS = ['schema', 'operation', 'root', 'repositoryKey', 'nodePath', 'entrypoint',
  'pluginRoot', 'pluginVersion', 'pluginDigest', 'runId', 'requestId', 'generation', 'payload'];
const OPERATIONS = new Set(['start', 'foreground', 'pause', 'resume', 'stop', 'stop-now', 'attach', 'disconnect', 'status']);
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exactKeys(value, keys) {
  return record(value) && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}
function uuid(value) { return typeof value === 'string' && UUID_RE.test(value); }
function hash(value) { return typeof value === 'string' && HASH_RE.test(value); }
function positive(value) { return Number.isSafeInteger(value) && value > 0; }
function text(value) { return typeof value === 'string' && value.length > 0 && !value.includes('\0'); }
function requireHost(passed, message) {
  if (!passed) throw new SchedulerError('HOST_AUTH_REQUIRED', message);
}
function validProfile(profile) {
  return exactKeys(profile, ['memoryMaxBytes', 'memorySwapMaxBytes', 'tasksMax'])
    && positive(profile.memoryMaxBytes) && Number.isSafeInteger(profile.memorySwapMaxBytes)
    && profile.memorySwapMaxBytes >= 0 && positive(profile.tasksMax);
}
export function validateLoopCommand(command) {
  if (!exactKeys(command, COMMAND_KEYS) || command.schema !== LOOP_COMMAND_SCHEMA || !OPERATIONS.has(command.operation)
    || !hash(command.repositoryKey) || !hash(command.pluginDigest) || !text(command.pluginVersion)
    || !['root', 'nodePath', 'entrypoint', 'pluginRoot'].every((key) => text(command[key]) && isAbsolute(command[key]))
    || (command.runId !== null && !uuid(command.runId)) || (command.requestId !== null && !uuid(command.requestId))
    || (command.generation !== null && !positive(command.generation))) return ['The normalized command is invalid.'];
  if (['start', 'foreground'].includes(command.operation)) {
    return exactKeys(command.payload, ['configDigest', 'modelsDigest', 'supervisorProfile'])
      && hash(command.payload.configDigest) && hash(command.payload.modelsDigest) && validProfile(command.payload.supervisorProfile)
      ? [] : ['The launch payload is invalid.'];
  }
  if (!exactKeys(command.payload, [])) return ['The operation payload is invalid.'];
  if (['pause', 'resume', 'stop', 'stop-now'].includes(command.operation)
    && !(uuid(command.runId) && uuid(command.requestId) && positive(command.generation))) return ['The control target is invalid.'];
  return [];
}
export function hostCommandDigest(command) {
  requireHost(validateLoopCommand(command).length === 0, 'The normalized command is invalid.');
  return schedulerDigest(command);
}
// userInfo reads the OS account. HOME/CLAUDE_* cannot select an authority store.
export function hostRuntimeRoot() {
  return join(userInfo().homedir, '.claude', 'autoloop', 'host-invocations');
}
function validProcess(identity) {
  return exactKeys(identity, ['pid', 'start', 'bootId']) && positive(identity.pid) && text(identity.start) && text(identity.bootId);
}
export function hostInvocationPath(host, invocationId, runtimeRoot = hostRuntimeRoot()) {
  requireHost(validProcess(host) && uuid(invocationId) && text(runtimeRoot) && isAbsolute(runtimeRoot), 'The host identity is invalid.');
  return join(resolve(runtimeRoot), `${host.pid}-${schedulerDigest({ start: host.start, bootId: host.bootId })}`, `${invocationId}.json`);
}

const HOST_KEYS = ['schema', 'invocationId', 'sessionId', 'commandDigest', 'host', 'issuedAt', 'expiresAt'];
export function validateHostInvocation(receipt, now = Date.now()) {
  return exactKeys(receipt, HOST_KEYS) && receipt.schema === HOST_INVOCATION_SCHEMA
    && uuid(receipt.invocationId) && uuid(receipt.sessionId) && hash(receipt.commandDigest) && validProcess(receipt.host)
    && Number.isSafeInteger(receipt.issuedAt) && Number.isSafeInteger(receipt.expiresAt)
    && receipt.issuedAt <= now && receipt.expiresAt > now && receipt.expiresAt > receipt.issuedAt
    && receipt.expiresAt - receipt.issuedAt <= HOST_INVOCATION_MAX_AGE_MS;
}
function privateDirectory(path) {
  const info = lstatSync(path);
  requireHost(info.isDirectory() && realpathSync(path) === resolve(path) && info.uid === userInfo().uid
    && (info.mode & 0o077) === 0, 'The host receipt directory is not private.');
}
function knownWorkers(command) {
  const repository = resolveRepository(command.root);
  requireHost(repository.repositoryKey === command.repositoryKey && repository.coordinatorRoot === command.root,
    'The command repository identity changed.');
  return readCurrentCheckpoint(repository)?.workers ?? [];
}
function rejectWorker(host, sessionId, workers) {
  requireHost(!workers.some((worker) => [worker.process.pid, worker.groupLeader.pid].includes(host.pid)
    || (sessionId !== null && sessionId === worker.sessionId)), 'A bound worker cannot issue operator commands.');
}
// Host PID/ancestry is a consistency check, not proof of UI origin. The trusted
// mod must issue this protected handoff only from a host-attested user gesture.
// Known model tool forms must be denied before production activation.
export async function admitHostInvocation(command, envelope, { runtimeRoot = hostRuntimeRoot(), now = Date.now() } = {}) {
  let fd;
  try {
    const digest = hostCommandDigest(command);
    requireHost(validateHostInvocation(envelope, now), 'The host invocation is expired or invalid.');
    requireHost(envelope.commandDigest === digest && envelope.host.pid === process.ppid, 'The invocation names another command or host.');
    const actualHost = readProcessIdentity(process.ppid);
    const entry = procEntry(process.ppid);
    requireHost(schedulerDigest(actualHost) === schedulerDigest(envelope.host) && entry !== null
      && isClaudeProcess(entry[1], entry[2]), 'The host process cannot be verified.');
    rejectWorker(actualHost, envelope.sessionId, knownWorkers(command));
    const path = hostInvocationPath(actualHost, envelope.invocationId, runtimeRoot);
    privateDirectory(resolve(runtimeRoot));
    privateDirectory(dirname(path));
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    requireHost(info.isFile() && info.uid === userInfo().uid && (info.mode & 0o077) === 0, 'The host receipt is not a private regular file.');
    const receipt = JSON.parse(readFileSync(fd, 'utf8'));
    requireHost(validateHostInvocation(receipt, now) && schedulerDigest(receipt) === schedulerDigest(envelope),
      'The host handoff does not match this invocation.');
    // Exclusive hard-link publication claims one receipt without overwriting an
    // earlier claim. The consumed marker remains; no expiry-based reclaim exists.
    const claimedPath = `${path}.claimed`;
    linkSync(path, claimedPath);
    const claimed = lstatSync(claimedPath);
    requireHost(claimed.isFile() && claimed.dev === info.dev && claimed.ino === info.ino,
      'The host receipt changed during claim.');
    return { kind: 'mod', sessionId: receipt.sessionId, host: actualHost, invocationId: receipt.invocationId };
  } catch (error) {
    if (error instanceof SchedulerError && error.code === 'HOST_AUTH_REQUIRED') throw error;
    throw new SchedulerError('HOST_AUTH_REQUIRED', 'The host invocation cannot be admitted.');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function terminalLine(fd) {
  return new Promise((done, fail) => {
    // The stream owns the descriptor from this point and closes it once.
    const stream = createReadStream(null, { fd, autoClose: true, encoding: 'utf8' });
    let received = '';
    let answer = null;
    let failure = null;
    stream.on('data', (chunk) => {
      received += chunk;
      const end = received.indexOf('\n');
      if (end !== -1) {
        answer = received.slice(0, end).trim();
        stream.destroy();
      }
    });
    stream.once('error', (error) => { failure = error; });
    stream.once('end', () => {
      if (answer === null) failure = new SchedulerError('HOST_AUTH_REQUIRED', 'Terminal confirmation ended without an answer.');
    });
    stream.once('close', () => failure ? fail(failure) : done(answer));
  });
}
export async function admitOperatorTerminal(command) {
  let fd;
  try {
    hostCommandDigest(command);
    const ancestors = new Set([process.pid, ...ancestorChain(process.ppid, procEntry)]);
    for (const pid of ancestors) {
      const entry = procEntry(pid);
      requireHost(entry === null || !isClaudeProcess(entry[1], entry[2]), 'Known Claude/model ancestry requires host admission.');
    }
    const current = readProcessIdentity();
    const workers = knownWorkers(command);
    requireHost(!workers.some((worker) => [worker.process.pid, worker.groupLeader.pid].some((pid) => ancestors.has(pid))),
      'A bound worker cannot confirm an operator command.');
    // /dev/tty is a real OS device, not stdin or an environment-selected file.
    // Confirmation and known-role checks are defense-in-depth, not OS isolation.
    fd = openSync('/dev/tty', constants.O_RDWR | constants.O_NOFOLLOW);
    requireHost(fstatSync(fd).isCharacterDevice() && isatty(fd), 'A live controlling terminal is required.');
    writeFileSync(fd, `Confirm autoloop ${command.operation} for ${command.root}. Type yes to continue: `);
    const terminal = fd;
    fd = undefined;
    requireHost(await terminalLine(terminal) === 'yes', 'The operator did not confirm this command.');
    return { kind: 'terminal', sessionId: null, host: current, invocationId: randomUUID() };
  } catch (error) {
    if (error instanceof SchedulerError && error.code === 'HOST_AUTH_REQUIRED') throw error;
    throw new SchedulerError('HOST_AUTH_REQUIRED', 'The terminal invocation cannot be admitted.');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

async function selfTest() {
  const cases = [];
  const check = async (name, run) => {
    try { await run(); cases.push([name, true]); }
    catch (error) { cases.push([name, false]); console.error(`FAIL ${name}: ${error.message}`); }
  };
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'loop-admission-')));
  const runHost = async (command, mode = 'valid') => {
    const runtimeRoot = join(scratch, randomUUID());
    mkdirSync(runtimeRoot, { mode: 0o700 });
    const fakeClaude = join(scratch, 'claude');
    if (!existsSync(fakeClaude)) copyFileSync(realpathSync(process.execPath), fakeClaude);
    const script = `import { spawn } from 'node:child_process'; import { dirname } from 'node:path';
      import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs'; import { randomUUID } from 'node:crypto';
      process.title = 'claude'; process.on('disconnect', () => process.exit(0));
      const api = await import(process.argv[1]); const core = await import(process.argv[2]);
      const command = JSON.parse(process.argv[3]); const runtimeRoot = process.argv[4]; const mode = process.argv[5];
      const host = core.readProcessIdentity(); const at = Date.now();
      const receipt = { schema: api.HOST_INVOCATION_SCHEMA, invocationId: randomUUID(), sessionId: randomUUID(),
        commandDigest: api.hostCommandDigest(command), host, issuedAt: at, expiresAt: at + 10000 };
      if (mode === 'expired') { receipt.issuedAt -= 20000; receipt.expiresAt -= 20000; }
      if (mode === 'future') { receipt.issuedAt += 10000; receipt.expiresAt += 10000; }
      const path = api.hostInvocationPath(host, receipt.invocationId, runtimeRoot);
      if (mode === 'worker') {
        const cfg = await import(process.argv[6]); const models = await import(process.argv[7]);
        const repository = core.resolveRepository(command.root);
        const config = cfg.resolveConfigText(JSON.stringify({ version: cfg.CONFIG_VERSION, baseBranch: 'main', gate: { command: 'node --version' } })).config;
        const pins = core.createPins(repository, { runId: command.runId, pluginRoot: command.pluginRoot, enginePath: command.nodePath,
          config, models: models.mergeModels(models.DEFAULT_MODELS) });
        const acquired = core.acquireScheduler(repository, pins, { kind: 'terminal', sessionId: null, process: host });
        const attemptId = randomUUID();
        core.registerWorker(acquired.lease, 1, { schema: 'autoloop.worker-binding/1', runId: pins.runId, generation: 1,
          unitId: randomUUID(), unitGeneration: 1, attemptId, sessionId: receipt.sessionId, worktreeGitDir: repository.commonDir,
          process: host, pgid: host.pid, groupLeader: host, role: 'implement', posture: 'writer', actualModel: 'fixture-host-worker',
          liveFile: repository.commonDir + '/autoloop/scheduler/runs/' + pins.runId + '/streams/' + attemptId + '.jsonl', cancelledByOperator: false },
          { guardDirectory: runtimeRoot + '/workers' });
      }
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      if (mode === 'link') { writeFileSync(path + '.outside', JSON.stringify(receipt), { mode: 0o600 }); symlinkSync(path + '.outside', path); }
      else if (mode !== 'missing') writeFileSync(path, JSON.stringify(receipt), { mode: 0o600 });
      let envelope = { ...receipt, host: { ...receipt.host } };
      let expected = command;
      if (mode === 'session') envelope.sessionId = randomUUID();
      if (mode === 'start') envelope.host.start = String(Number(envelope.host.start) + 1);
      if (mode === 'operation') expected = { ...command, operation: 'resume' };
      if (mode === 'target') expected = { ...command, requestId: randomUUID() };
      if (mode === 'payload') expected = { ...command, payload: { ...command.payload,
        supervisorProfile: { ...command.payload.supervisorProfile, tasksMax: command.payload.supervisorProfile.tasksMax + 1 } } };
      if (mode === 'by-ui') envelope.by = 'ui';
      const consumer = \`const api = await import(process.argv[1]); const command = JSON.parse(process.argv[2]);
        const envelope = JSON.parse(process.argv[3]); try {
          const actor = process.argv[5] === 'terminal-role' ? await api.admitOperatorTerminal(command)
            : await api.admitHostInvocation(command, envelope, { runtimeRoot: process.argv[4] });
          process.send({ ok: true, actor }, () => process.disconnect());
        } catch (error) { process.send({ ok: false, code: error.code }, () => process.disconnect()); }\`;
      const call = () => new Promise((done, fail) => {
        const child = spawn(command.nodePath, ['--input-type=module', '-e', consumer,
          process.argv[1], JSON.stringify(expected), JSON.stringify(envelope), runtimeRoot, mode], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        child.once('message', done); child.once('error', fail); child.once('close', (code) => { if (code !== 0) fail(new Error('Consumer failed')); });
      });
      const answers = mode === 'race' ? await Promise.all([call(), call()]) : [await call()];
      if (mode === 'replay') answers.push(await call());
      process.send({ answers, receipt }, () => process.disconnect());`;
    const child = spawn(fakeClaude, ['--input-type=module', '-e', script, import.meta.url,
      new URL('./scheduler-contract.mjs', import.meta.url).href, JSON.stringify(command), runtimeRoot, mode,
      new URL('./config-contract.mjs', import.meta.url).href, new URL('./models-config.mjs', import.meta.url).href], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], detached: true,
    });
    const identity = readProcessIdentity(child.pid);
    const closed = new Promise((done) => child.once('close', done));
    try {
      const result = await new Promise((done, fail) => {
        const timeout = setTimeout(() => fail(new Error('Host fixture timed out.')), 15000);
        let errorText = '';
        child.stderr.on('data', (chunk) => { errorText += chunk; });
        child.once('message', (value) => { clearTimeout(timeout); done(value); });
        child.once('close', (code) => { clearTimeout(timeout); fail(new Error(`Host fixture exited ${code}: ${errorText}`)); });
      });
      await closed;
      return result;
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        try { if (schedulerDigest(readProcessIdentity(child.pid)) === schedulerDigest(identity)) child.kill('SIGKILL'); } catch { /* already gone */ }
      }
      await closed;
    }
  };
  try {
    const root = join(scratch, 'repo');
    assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', root], { encoding: 'utf8', timeout: 15000 }).status, 0);
    const repository = resolveRepository(root);
    const command = {
      schema: 'autoloop.loop-command/1', operation: 'pause', root,
      repositoryKey: repository.repositoryKey, nodePath: realpathSync(process.execPath),
      entrypoint: realpathSync(fileURLToPath(import.meta.url)), pluginRoot: dirname(dirname(fileURLToPath(import.meta.url))),
      pluginVersion: '1.0.0', pluginDigest: schedulerDigest({ fixture: 'installed plugin identity' }),
      runId: randomUUID(), requestId: randomUUID(), generation: 1, payload: {},
    };
    await check('the command digest binds operation, repository, executable/plugin and full target/payload', () => {
      const digest = hostCommandDigest(command);
      for (const change of [{ operation: 'resume' }, { runId: randomUUID() }, { requestId: randomUUID() },
        { generation: 2 }, { root: join(scratch, 'other') }, { pluginDigest: schedulerDigest({ fixture: 'other' }) }]) {
        assert.notEqual(hostCommandDigest({ ...command, ...change }), digest);
      }
      assert.throws(() => hostCommandDigest({ ...command, by: 'ui' }), (error) => error.code === 'HOST_AUTH_REQUIRED');
    });
    await check('a real fake-Claude host handoff admits once and binds the actual host/session', async () => {
      const { answers, receipt } = await runHost(command, 'replay');
      assert.equal(answers[0].ok, true);
      assert.deepEqual(answers[0].actor, { kind: 'mod', sessionId: receipt.sessionId, host: receipt.host, invocationId: receipt.invocationId });
      assert.deepEqual(answers[1], { ok: false, code: 'HOST_AUTH_REQUIRED' });
    });
    await check('two real consumer processes cannot claim the same host receipt', async () => {
      const { answers } = await runHost(command, 'race');
      assert.equal(answers.filter((value) => value.ok).length, 1);
      assert.equal(answers.filter((value) => value.code === 'HOST_AUTH_REQUIRED').length, 1);
    });
    await check('expiry, future time, missing receipt, copied session and changed host/operation/target are refused', async () => {
      for (const mode of ['expired', 'future', 'missing', 'session', 'start', 'operation', 'target', 'by-ui', 'link']) {
        const { answers } = await runHost(command, mode);
        assert.deepEqual(answers, [{ ok: false, code: 'HOST_AUTH_REQUIRED' }], mode);
      }
    });
    await check('a valid launch payload substitution cannot reuse an approved profile', async () => {
      const launch = { ...command, operation: 'start', runId: null, requestId: null, generation: null,
        payload: { configDigest: schedulerDigest({ fixture: 'config' }), modelsDigest: schedulerDigest({ fixture: 'models' }),
          supervisorProfile: { memoryMaxBytes: 6442450944, memorySwapMaxBytes: 0, tasksMax: 2048 } } };
      assert.deepEqual((await runHost(launch, 'payload')).answers, [{ ok: false, code: 'HOST_AUTH_REQUIRED' }]);
    });
    await check('a real controlling terminal accepts explicit confirmation, not just a flag', () => {
      const entry = join(scratch, 'terminal-entry.mjs');
      writeFileSync(entry, `import { admitOperatorTerminal } from ${JSON.stringify(import.meta.url)};
        const command = JSON.parse(process.argv[2]); try {
          const actor = await admitOperatorTerminal(command); console.log('RESULT ' + JSON.stringify({ ok: true, kind: actor.kind }));
        } catch (error) { console.log('RESULT ' + JSON.stringify({ ok: false, code: error.code, message: error.message })); }`);
      const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
      const args = process.platform === 'darwin'
        ? ['-q', join(scratch, 'terminal.log'), process.execPath, entry, JSON.stringify(command)]
        : ['-q', '-e', '-c', [process.execPath, entry, JSON.stringify(command)].map(quote).join(' '), join(scratch, 'terminal.log')];
      for (const [answer, accepted] of [['yes\n', true], ['no\n', false]]) {
        const result = spawnSync('script', args, { input: answer, encoding: 'utf8', timeout: 15000 });
        assert.equal(result.status, 0, result.stderr || result.error?.message);
        const match = /RESULT (\{[^\r\n]+\})/u.exec(result.stdout);
        assert(match, result.stdout);
        assert.equal(JSON.parse(match[1]).ok, accepted, result.stdout);
      }
    });
    await check('a nonterminal or copied session environment does not admit a terminal mutation', async () => {
      const previous = process.env.CLAUDE_CODE_SESSION_ID;
      process.env.CLAUDE_CODE_SESSION_ID = randomUUID();
      try {
        await assert.rejects(() => admitOperatorTerminal(command), (error) => error.code === 'HOST_AUTH_REQUIRED');
      } finally {
        if (previous === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
        else process.env.CLAUDE_CODE_SESSION_ID = previous;
      }
    });
    await check('receipt authority root uses the OS account, not a caller HOME variable', () => {
      const previous = process.env.HOME;
      try {
        process.env.HOME = join(scratch, 'fake-home');
        assert.equal(hostRuntimeRoot(), join(userInfo().homedir, '.claude', 'autoloop', 'host-invocations'));
      } finally {
        if (previous === undefined) delete process.env.HOME;
        else process.env.HOME = previous;
      }
    });
    await check('known Claude ancestry cannot use terminal admission instead of a host handoff', async () => {
      assert.deepEqual((await runHost(command, 'terminal-role')).answers, [{ ok: false, code: 'HOST_AUTH_REQUIRED' }]);
    });
    await check('a bound worker host/session cannot turn its receipt into operator authority', async () => {
      assert.deepEqual((await runHost(command, 'worker')).answers, [{ ok: false, code: 'HOST_AUTH_REQUIRED' }]);
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const failed = cases.filter(([, passed]) => !passed);
  console.log(failed.length === 0 ? `self-test OK (${cases.length} cases)` : `self-test FAILED (${failed.length}/${cases.length})`);
  return failed.length === 0;
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); }
  catch { return false; }
})();
if (isMain) {
  if (process.argv.length === 3 && process.argv[2] === '--self-test') process.exit(await selfTest() ? 0 : 1);
  console.error('usage: loop-admission.mjs --self-test');
  process.exit(2);
}
