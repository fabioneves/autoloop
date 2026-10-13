#!/usr/bin/env node
// Linux supervision provider. No service mutation CLI is exposed here.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync, constants, cpSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireScheduler, assertNoKnownLegacyOwner, boundGroupState, commitTransition, createPins, DEFAULT_SUPERVISOR_PROFILE,
  hasUnresolvedEffects, listControlRequests, markEffectInFlight, prepareEffect, processIdentityState, readCheckpoint, readCurrentCheckpoint,
  readProcessIdentity, readSchedulerOwner, releaseScheduler, resolveRepository, schedulerDigest, SchedulerError,
  submitControl, validatePins,
} from './scheduler-contract.mjs';
import { CONFIG_VERSION, resolveConfigText } from './config-contract.mjs';
import { DEFAULT_MODELS, mergeModels } from './models-config.mjs';
import { readRegularFile } from './run-markers.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const LAUNCH_SCHEMA = 'autoloop.supervisor-launch/1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function requireCondition(passed, code, message) {
  if (!passed) throw new SchedulerError(code, message);
}
export function supervisorUnit(repository) {
  requireCondition(/^[0-9a-f]{64}$/u.test(repository.repositoryKey), 'INVALID_INPUT', 'The repository key is invalid.');
  return `autoloop-${repository.repositoryKey}.service`;
}
const SERVICE_PROPERTIES = ['Id', 'LoadState', 'ActiveState', 'SubState', 'MainPID', 'ControlGroup',
  'MemoryMax', 'MemorySwapMax', 'TasksMax', 'Restart', 'RuntimeMaxUSec', 'TimeoutStopUSec', 'KillMode'];
function commandEnvironment() {
  const account = userInfo();
  return { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: account.homedir, LANG: 'C.UTF-8',
    XDG_RUNTIME_DIR: `/run/user/${account.uid}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${account.uid}/bus` };
}
function executable(path) {
  requireCondition(typeof path === 'string' && isAbsolute(path), 'SUPERVISOR_UNAVAILABLE', 'An absolute supervisor executable is required.');
  try {
    const actual = realpathSync(path);
    requireCondition(lstatSync(actual).isFile(), 'SUPERVISOR_UNAVAILABLE', 'The supervisor executable is not a file.');
    return actual;
  } catch { throw new SchedulerError('SUPERVISOR_UNAVAILABLE', 'The supervisor executable is not available.'); }
}
async function externalCommand(path, args) {
  return new Promise((done) => {
    const child = spawn(path, args, { env: commandEnvironment(), stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    let overflow = false;
    let identity = null;
    try { identity = readProcessIdentity(child.pid); } catch { /* never signal an unverified child */ }
    const stopOwned = () => {
      overflow = true;
      if (identity && processIdentityState(identity) === 'alive') child.kill('SIGKILL');
    };
    const timer = setTimeout(stopOwned, 5000);
    child.stdout.on('data', (chunk) => {
      if (overflow) return;
      output += chunk;
      if (Buffer.byteLength(output) > 1024 * 1024) stopOwned();
    });
    child.once('error', () => { clearTimeout(timer); done({ ok: false, output: '' }); });
    child.once('close', (code) => { clearTimeout(timer); done({ ok: code === 0 && !overflow, output }); });
  });
}
function properties(text, allowed) {
  const value = {};
  for (const line of text.trim().split('\n')) {
    const index = line.indexOf('=');
    const key = line.slice(0, index);
    requireCondition(index > 0 && allowed.includes(key) && !(key in value), 'READINESS_FAILED', 'The supervisor response is invalid.');
    value[key] = line.slice(index + 1);
  }
  requireCondition(allowed.every((key) => key in value), 'READINESS_FAILED', 'The supervisor response is incomplete.');
  return value;
}
async function serviceState(systemctlPath, unit) {
  const result = await externalCommand(systemctlPath, ['--user', 'show', unit, ...SERVICE_PROPERTIES.map((key) => `--property=${key}`)]);
  requireCondition(result.ok, 'SUPERVISOR_UNAVAILABLE', 'The user service cannot be read.');
  return properties(result.output, SERVICE_PROPERTIES);
}
function profileMatches(service, pins) {
  const profile = pins.supervisorProfile;
  return service.MemoryMax === String(profile.memoryMaxBytes) && service.MemorySwapMax === String(profile.memorySwapMaxBytes)
    && service.TasksMax === String(profile.tasksMax) && service.Restart === 'on-failure'
    && service.RuntimeMaxUSec === 'infinity' && service.TimeoutStopUSec === 'infinity' && service.KillMode === 'process';
}
function verifyServiceProcess(service, pins, expectedProcess = null) {
  requireCondition(service.Id === supervisorUnit(pins) && service.LoadState === 'loaded' && service.ActiveState === 'active'
    && service.SubState === 'running' && /^[1-9]\d*$/u.test(service.MainPID) && Number.isSafeInteger(Number(service.MainPID))
    && profileMatches(service, pins), 'READINESS_FAILED', 'The service identity or containment is not ready.');
  const identity = readProcessIdentity(Number(service.MainPID));
  if (expectedProcess) requireCondition(schedulerDigest(identity) === schedulerDigest(expectedProcess),
    'HOST_AUTH_REQUIRED', 'This process is not the service owner.');
  const lines = readRegularFile(`/proc/${identity.pid}/cgroup`).trim().split('\n');
  const cgroup = lines.find((line) => line.startsWith('0::'))?.slice(3);
  requireCondition(typeof cgroup === 'string' && cgroup.startsWith('/') && !cgroup.split('/').includes('..')
    && cgroup === service.ControlGroup, 'READINESS_FAILED', 'The service process cgroup cannot be verified.');
  const path = join('/sys/fs/cgroup', cgroup);
  requireCondition(realpathSync(path) === path, 'READINESS_FAILED', 'The service cgroup path is invalid.');
  for (const [name, wanted] of [['memory.max', pins.supervisorProfile.memoryMaxBytes],
    ['memory.swap.max', pins.supervisorProfile.memorySwapMaxBytes], ['pids.max', pins.supervisorProfile.tasksMax]]) {
    requireCondition(readRegularFile(join(path, name)).trim() === String(wanted), 'READINESS_FAILED', 'The actual service limits do not match the pins.');
  }
  requireCondition(schedulerDigest(readProcessIdentity(identity.pid)) === schedulerDigest(identity),
    'READINESS_FAILED', 'The service owner changed during verification.');
  return identity;
}
function launchStorageDirectory(path, create = false, privateMode = true, observe = () => {}) {
  if (create) {
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw new SchedulerError('STATE_IO_FAILED', 'The launch directory cannot be created.'); }
  }
  requireCondition(lstatSync(path).isDirectory() && realpathSync(path) === path,
    'HOST_AUTH_REQUIRED', 'The launch storage is not a real directory.');
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    requireCondition(stat.isDirectory() && stat.uid === userInfo().uid && (!privateMode || (stat.mode & 0o077) === 0),
      'HOST_AUTH_REQUIRED', 'The launch directory ownership or mode is invalid.');
  } finally { closeSync(fd); }
  if (create) {
    const parent = launchStorageDirectory(dirname(path), false, false);
    const parentFd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      requireCondition(fstatSync(parentFd).isDirectory(), 'HOST_AUTH_REQUIRED', 'The launch parent is not a directory.');
      observe('directory-parent-sync', path);
      fsyncSync(parentFd);
      observe('directory-parent-flushed', path);
    } finally { closeSync(parentFd); }
  }
  return path;
}
function launchDirectory(repository, create = false, observe = () => {}) {
  // Git and legacy models share these ancestors. Do not change their modes.
  let path = launchStorageDirectory(repository.commonDir, false, false);
  path = launchStorageDirectory(join(path, 'autoloop'), create, false, observe);
  for (const name of ['scheduler', 'launches']) path = launchStorageDirectory(join(path, name), create, true, observe);
  return path;
}
function publishLaunch(repository, value, observe = () => {}) {
  const directory = launchDirectory(repository, true, observe);
  const staged = join(directory, `staged-${value.launchId}.json`);
  const final = join(directory, `${value.launchId}.json`);
  const fd = openSync(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  // Retain both links. Authoritative launch records are not pruned automatically.
  linkSync(staged, final);
  observe('launch-published', final);
  const dirfd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(dirfd); } finally { closeSync(dirfd); }
}
function validInitiator(value, live = false) {
  if (!value || Object.keys(value).sort().join(',') !== 'kind,process,sessionId'
    || !['terminal', 'mod'].includes(value.kind)
    || (value.kind === 'terminal' ? value.sessionId !== null : typeof value.sessionId !== 'string' || !UUID_RE.test(value.sessionId))) return false;
  try {
    const state = processIdentityState(value.process);
    return !live || state === 'alive';
  } catch { return false; }
}
function launchDigest(value) {
  const { commandDigest, ...intent } = value;
  return schedulerDigest(intent);
}
function readLaunch(repository, launchId) {
  requireCondition(typeof launchId === 'string' && UUID_RE.test(launchId), 'HOST_AUTH_REQUIRED', 'The launch receipt ID is invalid.');
  try {
    const path = join(launchDirectory(repository), `${launchId}.json`);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let value;
    try {
      const stat = fstatSync(fd);
      requireCondition(stat.isFile() && stat.uid === userInfo().uid && (stat.mode & 0o077) === 0, 'HOST_AUTH_REQUIRED', 'The launch receipt is not private.');
      value = JSON.parse(readFileSync(fd, 'utf8'));
    } finally { closeSync(fd); }
    const keys = ['schema', 'launchId', 'repositoryKey', 'runId', 'unit', 'pins', 'initiator', 'launcher',
      'systemctlPath', 'argv', 'minimumGeneration', 'createdAt', 'commandDigest'];
    requireCondition(value && Object.keys(value).sort().join(',') === keys.sort().join(',') && value.schema === LAUNCH_SCHEMA
      && value.launchId === launchId && value.runId === value.pins?.runId && value.repositoryKey === repository.repositoryKey
      && value.unit === supervisorUnit(repository) && validatePins(value.pins).length === 0
      && value.pins.repositoryKey === repository.repositoryKey && value.pins.commonDir === repository.commonDir
      && value.commandDigest === launchDigest(value) && validInitiator(value.initiator)
      && validInitiator({ kind: 'terminal', sessionId: null, process: value.launcher }) && Array.isArray(value.argv)
      && value.argv.every((argument) => typeof argument === 'string' && !argument.includes('\0'))
      && Number.isSafeInteger(value.minimumGeneration) && value.minimumGeneration > 0
      && Number.isSafeInteger(value.createdAt) && value.createdAt >= 0, 'HOST_AUTH_REQUIRED', 'The launch receipt is invalid.');
    executable(value.systemctlPath);
    return value;
  } catch (error) {
    if (error instanceof SchedulerError && error.code === 'HOST_AUTH_REQUIRED') throw error;
    throw new SchedulerError('HOST_AUTH_REQUIRED', 'The launch handoff cannot be verified.');
  }
}
function readyCheckpoint(repository, pins, identity, minimumGeneration = 1) {
  const checkpoint = readCurrentCheckpoint(repository);
  const owner = readSchedulerOwner(repository);
  requireCondition(checkpoint && checkpoint.runId === pins.runId && checkpoint.generation >= minimumGeneration
    && checkpoint.pinsDigest === schedulerDigest(pins) && ['recovering', 'running', 'paused', 'draining'].includes(checkpoint.state)
    && owner.state === 'alive' && !owner.released && owner.lease.runId === checkpoint.runId
    && owner.lease.generation === checkpoint.generation && schedulerDigest(owner.lease.owner) === schedulerDigest(identity)
    && schedulerDigest(checkpoint.owner) === schedulerDigest(identity), 'READINESS_FAILED', 'The checkpoint is not ready for this service.');
  return { runId: checkpoint.runId, generation: checkpoint.generation, state: checkpoint.state, queueEnabled: false };
}
function serviceArguments(repository, pins, launchId) {
  return [pins.nodePath, join(pins.pluginRoot, 'tools', 'loop.mjs'), 'run', '--supervised', '--root', pins.coordinatorRoot,
    '--run', pins.runId, '--launch-receipt', launchId];
}
export async function startSupervised({ repository, pins, initiator, systemdRunPath = '/usr/bin/systemd-run',
  systemctlPath = '/usr/bin/systemctl', readinessTimeoutMs = 15000, pollMs = 100, platform = process.platform, observe = () => {} } = {}) {
  requireCondition(platform === 'linux' && process.platform === 'linux', 'SUPERVISOR_UNAVAILABLE', 'Daemon supervision requires Linux systemd.');
  requireCondition(validatePins(pins).length === 0 && pins.repositoryKey === repository?.repositoryKey
    && pins.commonDir === repository.commonDir && resolveRepository(pins.coordinatorRoot).repositoryKey === repository.repositoryKey,
  'INVALID_INPUT', 'The supervisor pins are invalid.');
  pins = JSON.parse(JSON.stringify(pins));
  repository = resolveRepository(repository.coordinatorRoot);
  requireCondition(repository.repositoryKey === pins.repositoryKey && repository.commonDir === pins.commonDir,
    'REPOSITORY_INVALID', 'The supervisor repository changed.');
  requireCondition(Number.isSafeInteger(readinessTimeoutMs) && readinessTimeoutMs > 0 && Number.isSafeInteger(pollMs) && pollMs > 0,
    'INVALID_INPUT', 'The readiness interval is invalid.');
  requireCondition(validInitiator(initiator, true), 'HOST_AUTH_REQUIRED', 'The initiating process is not verified.');
  initiator = JSON.parse(JSON.stringify(initiator));
  assertNoKnownLegacyOwner(repository);
  systemctlPath = executable(systemctlPath);
  systemdRunPath = executable(systemdRunPath);
  const manager = await externalCommand(systemctlPath, ['--user', 'show', '--property=Version']);
  requireCondition(manager.ok && properties(manager.output, ['Version']).Version !== '', 'SUPERVISOR_UNAVAILABLE', 'The systemd user manager is not available.');
  const unit = supervisorUnit(repository);
  const current = readCurrentCheckpoint(repository);
  const owner = readSchedulerOwner(repository);
  requireCondition(!current?.workers.some((worker) => [worker.process.pid, worker.groupLeader.pid].includes(initiator.process.pid)
    || (initiator.sessionId !== null && worker.sessionId === initiator.sessionId)), 'HOST_AUTH_REQUIRED', 'A bound worker cannot launch a service.');
  const previous = await serviceState(systemctlPath, unit);
  if (owner.state === 'alive') {
    requireCondition(current?.runId === pins.runId && previous.MainPID === String(current.owner.pid),
      'SCHEDULER_ACTIVE', 'Another scheduler owns this repository.');
    const identity = verifyServiceProcess(previous, pins);
    return { ...readyCheckpoint(repository, pins, identity), alreadyRunning: true, unit };
  }
  requireCondition(owner.state !== 'unknown', 'OWNER_UNVERIFIED', 'The preceding scheduler cannot be verified.');
  requireCondition(previous.MainPID === '0' && previous.ActiveState !== 'active', 'SCHEDULER_ACTIVE', 'The named service is already active.');
  const requiresRecovery = current && (current.state !== 'stopped' || current.workers.some((worker) => boundGroupState(worker) !== 'empty')
    || hasUnresolvedEffects(current)
    || listControlRequests(repository, current.runId).length > 0);
  requireCondition(!requiresRecovery || current.runId === pins.runId, 'RUN_MISMATCH', 'Recover the retained run before launching another.');
  const launchId = randomUUID();
  const argv = serviceArguments(repository, pins, launchId);
  const launch = { schema: LAUNCH_SCHEMA, launchId, repositoryKey: repository.repositoryKey, runId: pins.runId, unit,
    pins, initiator, launcher: readProcessIdentity(), systemctlPath, argv,
    minimumGeneration: current?.runId === pins.runId ? current.generation + 1 : 1, createdAt: Date.now() };
  launch.commandDigest = launchDigest(launch);
  try { publishLaunch(repository, launch, observe); }
  catch (error) {
    if (error instanceof SchedulerError) throw error;
    throw new SchedulerError('STATE_IO_FAILED', 'The durable launch record could not be published.');
  }
  const profile = pins.supervisorProfile;
  const args = ['--user', '--collect', `--unit=${unit}`, '--property=Type=exec', '--property=Restart=on-failure', '--property=KillMode=process',
    '--property=TimeoutStopSec=infinity', `--property=MemoryMax=${profile.memoryMaxBytes}`,
    `--property=MemorySwapMax=${profile.memorySwapMaxBytes}`, `--property=TasksMax=${profile.tasksMax}`,
    '--property=MemoryAccounting=yes', '--property=TasksAccounting=yes', `--working-directory=${pins.coordinatorRoot}`,
    '--setenv=PATH=/usr/local/bin:/usr/bin:/bin', `--setenv=HOME=${userInfo().homedir}`, ...argv];
  const started = await externalCommand(systemdRunPath, args);
  if (!started.ok) {
    const actual = await serviceState(systemctlPath, unit);
    requireCondition(actual.ActiveState !== 'active' && actual.MainPID === '0', 'SCHEDULER_ACTIVE', 'Another launcher owns the named service.');
    throw new SchedulerError('SUPERVISOR_UNAVAILABLE', 'The named service could not be launched.');
  }
  const deadline = Date.now() + readinessTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const service = await serviceState(systemctlPath, unit);
      const identity = verifyServiceProcess(service, pins);
      return { ...readyCheckpoint(repository, pins, identity, launch.minimumGeneration), alreadyRunning: false, unit };
    } catch (error) {
      if (!['READINESS_FAILED', 'OWNER_UNVERIFIED', 'RECOVERY_REQUIRED', 'RUN_NOT_FOUND', 'STATE_IO_FAILED'].includes(error.code)
        && !['ENOENT', 'ESRCH'].includes(error.code)) throw error;
    }
    await new Promise((done) => setTimeout(done, pollMs));
  }
  throw new SchedulerError('READINESS_FAILED', 'The service did not report verified readiness. Launch state is retained.');
}
export async function verifySupervisedLaunch({ repository, runId, launchReceipt }) {
  requireCondition(process.platform === 'linux', 'SUPERVISOR_UNAVAILABLE', 'Daemon supervision requires Linux systemd.');
  const launch = readLaunch(repository, launchReceipt);
  const expected = serviceArguments(repository, launch.pins, launchReceipt);
  requireCondition(launch.runId === runId && launch.pins.coordinatorRoot === repository.coordinatorRoot
    && schedulerDigest(launch.argv) === schedulerDigest(expected) && realpathSync(process.execPath) === launch.pins.nodePath
    && realpathSync(process.argv[1]) === expected[1] && schedulerDigest(process.argv.slice(2)) === schedulerDigest(expected.slice(2)),
  'HOST_AUTH_REQUIRED', 'This invocation does not match the service handoff.');
  const identity = readProcessIdentity();
  const deadline = Date.now() + 5000;
  let verified = false;
  while (Date.now() < deadline) {
    try {
      verifyServiceProcess(await serviceState(launch.systemctlPath, launch.unit), launch.pins, identity);
      verified = true;
      break;
    } catch (error) {
      if (error.code === 'HOST_AUTH_REQUIRED') throw error;
      if (!['READINESS_FAILED', 'OWNER_UNVERIFIED'].includes(error.code)) throw new SchedulerError('HOST_AUTH_REQUIRED', 'The service identity is not verified.');
    }
    await new Promise((done) => setTimeout(done, 25));
  }
  requireCondition(verified, 'HOST_AUTH_REQUIRED', 'The service did not establish verified containment.');
  return { repository, pins: launch.pins, initiator: launch.initiator };
}

function parseSupervisorSelfTestArgs(argv) {
  requireCondition(argv[0] === '--self-test' && (argv.length === 1 || (argv.length === 2 && argv[1] === '--require-supervision')),
    'INVALID_INPUT', 'The supervisor self-test arguments are invalid.');
  return { requireSupervision: argv.length === 2 };
}
function supervisionTestContained() {
  if (process.platform !== 'linux') return false;
  try {
    const cgroup = readRegularFile('/proc/self/cgroup').trim().split('\n').find((line) => line.startsWith('0::')).slice(3);
    const path = join('/sys/fs/cgroup', cgroup);
    return realpathSync(path) === path && readRegularFile(join(path, 'memory.max')).trim() === '6442450944'
      && readRegularFile(join(path, 'memory.swap.max')).trim() === '0' && readRegularFile(join(path, 'pids.max')).trim() === '2048';
  } catch { return false; }
}
function requireSupervisionCapability(required, contained) {
  requireCondition(!required || contained, 'SUPERVISION_TEST_REQUIRED',
    'Required supervision tests need Linux with MemoryMax=6G, MemorySwapMax=0 and TasksMax=2048.');
}
async function selfTest({ requireSupervision = false } = {}) {
  const containedFixture = supervisionTestContained();
  try { requireSupervisionCapability(requireSupervision, containedFixture); }
  catch (error) { console.error(`FAIL required supervision: ${error.message}`); return false; }
  const results = [];
  const check = async (name, run) => {
    try { await run(); results.push([name, true]); }
    catch (error) { results.push([name, false]); console.error(`FAIL ${name}: ${error.message}`); }
  };
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'loop-supervisor-')));
  // Use actual installed code in a fixed snapshot, not first-party test doubles.
  const pluginRoot = join(scratch, 'plugin');
  mkdirSync(pluginRoot);
  for (const name of ['.claude-plugin', 'tools', 'hooks', 'skills', 'templates', 'types']) {
    if (existsSync(join(ROOT, name))) cpSync(join(ROOT, name), join(pluginRoot, name), { recursive: true });
  }
  const managers = new Set();
  const waitFor = async (predicate, message) => {
    const deadline = Date.now() + 15000;
    while (!predicate()) {
      assert(Date.now() < deadline, message);
      await new Promise((done) => setTimeout(done, 10));
    }
  };
  const fixture = async ({ publicCli = false } = {}) => {
    const home = join(scratch, randomUUID());
    mkdirSync(home);
    const checkout = join(home, 'repo');
    assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', checkout], { encoding: 'utf8', timeout: 15000 }).status, 0);
    const repository = resolveRepository(checkout);
    const config = resolveConfigText(JSON.stringify({ version: CONFIG_VERSION, baseBranch: 'main', gate: { command: 'node --version' } })).config;
    const pins = createPins(repository, { pluginRoot, enginePath: realpathSync(process.execPath), config, models: mergeModels(DEFAULT_MODELS) });
    const socket = join(home, 'manager.sock');
    const state = join(home, 'service.json');
    const mode = join(home, 'mode.json');
    const log = join(home, 'calls.jsonl');
    writeFileSync(mode, '{}');
    writeFileSync(log, '');
    const accountHome = join(home, 'account'); mkdirSync(accountHome);
    const preload = join(home, 'external-platform.mjs');
    // Only external OS-account location and exact supervisor calls are replaced.
    // First-party admission, helper, CLI, checkpoint and kernel readback stay real.
    writeFileSync(preload, `import os from 'node:os'; import cp from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module';
const actualAccount = os.userInfo; const actualSpawn = cp.spawn;
os.userInfo = (...args) => ({ ...actualAccount(...args), homedir: ${JSON.stringify(accountHome)} });
os.homedir = () => ${JSON.stringify(accountHome)};
cp.spawn = (file, args, options) => {
  if (file === '/usr/bin/systemctl') {
    if (args[0] !== '--user' || args[1] !== 'show') throw Error('Unexpected supervisor fixture operation');
    return actualSpawn(${JSON.stringify(join(home, 'systemctl'))}, args, options);
  }
  if (file === '/usr/bin/systemd-run') {
    if (!args.includes('--user') || !args.some((arg) => /^--unit=autoloop-[0-9a-f]{64}\\.service$/u.test(arg))) throw Error('Unexpected supervisor fixture launch');
    return actualSpawn(${JSON.stringify(join(home, 'systemd-run'))}, args, options);
  }
  if (/(?:^|\\/)(?:systemctl|systemd-run)$/u.test(file)) throw Error('Unexpected supervisor fixture executable');
  return actualSpawn(file, args, options);
}; syncBuiltinESMExports();\n`);
    const settings = { socket, state, mode, log, node: process.execPath, preload: publicCli ? preload : null };
    const managerFile = join(home, 'manager.mjs');
    writeFileSync(managerFile, `import { createServer } from 'node:net'; import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';
const settings = ${JSON.stringify(settings)}; const children = new Set(); let closing = false;
const save = (value) => {writeFileSync(settings.state+'.next', JSON.stringify(value)); renameSync(settings.state+'.next',settings.state);};
save({Id:'',LoadState:'not-found',ActiveState:'inactive',SubState:'dead',MainPID:'0',ControlGroup:''});
function start(args) {
  const unit = args.find((arg) => arg.startsWith('--unit=')).slice(7);
  const index = args.indexOf(settings.node); const command = args.slice(index);
  const cwd = args.find((arg) => arg.startsWith('--working-directory=')).slice(20);
  const child = spawn(command[0], [...(settings.preload ? ['--import', settings.preload] : []), ...command.slice(1)], {cwd,detached:true,stdio:['ignore','ignore','pipe']});
  children.add(child); let error=''; child.stderr.on('data',(chunk)=>{error+=chunk;});
  const stat=readFileSync('/proc/'+child.pid+'/stat','utf8'); const birth=stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];
  appendFileSync(settings.log,JSON.stringify({tool:'spawn',identity:{pid:child.pid,start:birth,bootId:readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()}})+'\\n');
  const cgroup = readFileSync('/proc/'+child.pid+'/cgroup','utf8').trim().split('0::')[1];
  const property = (name) => args.find((arg) => arg.startsWith('--property='+name+'=')).split('=').slice(2).join('=');
  save({Id:unit,LoadState:'loaded',ActiveState:'active',SubState:'running',MainPID:String(child.pid),ControlGroup:cgroup,
    MemoryMax:property('MemoryMax'),MemorySwapMax:property('MemorySwapMax'),TasksMax:property('TasksMax'),Restart:property('Restart'),
    RuntimeMaxUSec:'infinity',TimeoutStopUSec:'infinity',KillMode:property('KillMode')});
  child.once('close',(code,signal)=>{children.delete(child); const value=JSON.parse(readFileSync(settings.state));
    if(value.MainPID===String(child.pid)) save({...value,MainPID:'0',ActiveState:'inactive',SubState:'dead',error});
    if(!closing && (code!==0 || signal)) setTimeout(()=>{if(!closing) start(args);},100);
  });
}
const server = createServer((connection) => { let text=''; connection.on('data', (chunk) => { text += chunk; }); connection.on('end', () => {
  const args = JSON.parse(text); appendFileSync(settings.log, JSON.stringify({tool:'run',args})+'\\n');
  const current = JSON.parse(readFileSync(settings.state));
  if (current.MainPID !== '0') { connection.end('unit-exists'); return; }
  start(args); connection.end('ok');
}); });
server.listen(settings.socket,()=>process.send({ready:true}));
async function stop() { closing=true; server.close();
  await Promise.all([...children].map((child)=>new Promise((done)=>{
    const timer=setTimeout(()=>child.kill('SIGKILL'),3000);
    child.once('close',()=>{clearTimeout(timer);done();}); child.kill('SIGTERM');
  }))); process.exit(0);
}
process.on('message',stop); process.on('disconnect',stop);`);
    const manager = spawn(process.execPath, [managerFile], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    manager.log = log;
    manager.errors = '';
    manager.stderr.on('data', (chunk) => { manager.errors += chunk; });
    manager.closed = new Promise((done) => manager.once('close', done));
    managers.add(manager);
    await new Promise((done) => manager.once('message', done));
    const systemdRunPath = join(home, 'systemd-run');
    writeFileSync(systemdRunPath, `#!${process.execPath}\nimport {createConnection} from 'node:net';
const socket=${JSON.stringify(socket)}; const connection=createConnection(socket); let result='';
connection.on('connect',()=>connection.end(JSON.stringify(process.argv.slice(2)))); connection.on('data',(chunk)=>{result+=chunk;});
connection.on('end',()=>process.exit(result==='ok'?0:1)); connection.on('error',()=>process.exit(1));\n`, { mode: 0o700 });
    const systemctlPath = join(home, 'systemctl');
    writeFileSync(systemctlPath, `#!${process.execPath}\nimport {readFileSync,appendFileSync} from 'node:fs';
const settings=${JSON.stringify(settings)}; const args=process.argv.slice(2); const mode=JSON.parse(readFileSync(settings.mode));
appendFileSync(settings.log,JSON.stringify({tool:'show',args})+'\\n');
if(mode.unavailable) process.exit(1);
if(args.includes('--property=Version')) {console.log('Version=fixture'); process.exit(0);}
const stored=JSON.parse(readFileSync(settings.state)); const value={...stored,...(stored.Id ? mode.properties??{} : {})};
for(const key of args.filter((arg)=>arg.startsWith('--property=')).map((arg)=>arg.slice(11))) console.log(key+'='+(value[key]??''));\n`, { mode: 0o700 });
    return { home, accountHome, preload, repository, pins, manager, state, mode, log, systemdRunPath, systemctlPath };
  };
  const initiator = () => ({ kind: 'terminal', sessionId: null, process: readProcessIdentity() });
  const actor = () => ({ kind: 'terminal', sessionId: null, host: readProcessIdentity(), invocationId: randomUUID() });
  const launch = (setup, extra = {}) => startSupervised({ repository: setup.repository, pins: setup.pins,
    initiator: initiator(), systemdRunPath: setup.systemdRunPath, systemctlPath: setup.systemctlPath,
    readinessTimeoutMs: 2000, pollMs: 25, ...extra });
  try {
    await check('required supervision self-test arguments and missing containment fail closed', () => {
      assert.deepEqual(parseSupervisorSelfTestArgs(['--self-test']), { requireSupervision: false });
      assert.deepEqual(parseSupervisorSelfTestArgs(['--self-test', '--require-supervision']), { requireSupervision: true });
      assert.throws(() => parseSupervisorSelfTestArgs(['--require-supervision']), (error) => error.code === 'INVALID_INPUT');
      assert.throws(() => parseSupervisorSelfTestArgs(['--self-test', '--require-supervision', '--extra']), (error) => error.code === 'INVALID_INPUT');
      assert.throws(() => requireSupervisionCapability(true, false), (error) => error.code === 'SUPERVISION_TEST_REQUIRED');
      assert.doesNotThrow(() => requireSupervisionCapability(false, false));
      assert.doesNotThrow(() => requireSupervisionCapability(true, true));
    });
    await check('unreadable kernel containment cannot satisfy required supervision', async () => {
      const fs = (await import('node:fs')).default;
      const { syncBuiltinESMExports } = await import('node:module'); const original = fs.openSync;
      try {
        // External filesystem failure, not a replacement supervisor predicate.
        fs.openSync = (path, ...args) => {
          if (typeof path === 'string' && path.startsWith('/sys/fs/cgroup/') && path.endsWith('/pids.max')) {
            throw Object.assign(new Error('kernel cap read denied'), { code: 'EACCES' });
          }
          return original(path, ...args);
        };
        syncBuiltinESMExports();
        assert.equal(supervisionTestContained(), false);
        assert.throws(() => requireSupervisionCapability(true, supervisionTestContained()), (error) => error.code === 'SUPERVISION_TEST_REQUIRED');
      } finally { fs.openSync = original; syncBuiltinESMExports(); }
    });
    await check('stable supervisor names use canonical common-directory identity', () => {
      assert.equal(supervisorUnit({ repositoryKey: 'a'.repeat(64) }), `autoloop-${'a'.repeat(64)}.service`);
      assert.throws(() => supervisorUnit({ repositoryKey: '../bad' }), (error) => error.code === 'INVALID_INPUT');
    });
    if (process.platform === 'linux') {
      if (!containedFixture) console.error('SKIP positive supervised lifecycle: run the test under MemoryMax=6G, MemorySwapMax=0 and TasksMax=2048.');
      if (containedFixture) await check('launch directory parent flushes precede handoff publication and fsync failure refuses launch', async () => {
        const setup = await fixture(); const operations = [];
        const ready = await launch(setup, { observe: (phase, path) => operations.push([phase, path]) });
        const publication = operations.findIndex(([phase]) => phase === 'launch-published');
        for (const name of ['autoloop', 'autoloop/scheduler', 'autoloop/scheduler/launches']) {
          const flushed = operations.findIndex(([phase, path]) => phase === 'directory-parent-flushed' && path === join(setup.repository.commonDir, name));
          assert(flushed >= 0 && publication > flushed, `Launch ancestor ${name} must be durable before handoff.`);
        }
        submitControl(setup.repository, actor(), { schema: 'autoloop.control/2', requestId: randomUUID(), runId: ready.runId,
          kind: 'stop', target: { type: 'run', generation: ready.generation }, payload: {}, submittedAt: Date.now() });
        await waitFor(() => JSON.parse(readFileSync(setup.state)).MainPID === '0', 'The flush fixture daemon did not stop.');
        const failed = await fixture();
        await assert.rejects(launch(failed, { observe: (phase, path) => {
          if (phase === 'directory-parent-sync' && path.endsWith('/launches')) throw Object.assign(new Error('parent fsync failure'), { code: 'EIO' });
        } }), (error) => error.code === 'STATE_IO_FAILED');
        assert.equal(readFileSync(failed.log, 'utf8').includes('"tool":"run"'), false);
      });
      if (containedFixture) await check('a drained legacy 0755 autoloop directory starts without changing its mode', async () => {
        const setup = await fixture();
        const legacy = join(setup.repository.commonDir, 'autoloop');
        const { chmodSync } = await import('node:fs');
        mkdirSync(legacy, { mode: 0o755 }); chmodSync(legacy, 0o755);
        writeFileSync(join(legacy, 'models.json'), '{"legacy":"retained"}\n');
        const ready = await launch(setup);
        assert.equal(ready.state, 'running');
        assert.equal(lstatSync(legacy).mode & 0o777, 0o755);
        assert.equal(readFileSync(join(legacy, 'models.json'), 'utf8'), '{"legacy":"retained"}\n');
        for (const name of ['scheduler', 'scheduler/launches']) assert.equal(lstatSync(join(legacy, name)).mode & 0o777, 0o700);
        submitControl(setup.repository, actor(), { schema: 'autoloop.control/2', requestId: randomUUID(), runId: ready.runId,
          kind: 'stop', target: { type: 'run', generation: ready.generation }, payload: {}, submittedAt: Date.now() });
        await waitFor(() => JSON.parse(readFileSync(setup.state)).MainPID === '0', 'The legacy fixture daemon did not stop.');
      });
      await check('launch namespaces reject links and loose private scheduler directories', async () => {
        const { symlinkSync, chmodSync } = await import('node:fs');
        for (const name of ['autoloop', 'autoloop/scheduler', 'autoloop/scheduler/launches']) {
          const setup = await fixture();
          const path = join(setup.repository.commonDir, name);
          mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
          const outside = join(setup.home, 'outside'); mkdirSync(outside, { mode: 0o700 });
          symlinkSync(outside, path);
          await assert.rejects(launch(setup), (error) => ['HOST_AUTH_REQUIRED', 'LEGACY_RUN_ACTIVE', 'STATE_INVALID'].includes(error.code));
          assert.equal(readFileSync(setup.log, 'utf8').includes('"tool":"run"'), false);
        }
        for (const name of ['autoloop/scheduler', 'autoloop/scheduler/launches']) {
          const setup = await fixture();
          const path = join(setup.repository.commonDir, name);
          mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o755);
          await assert.rejects(launch(setup), (error) => error.code === 'HOST_AUTH_REQUIRED');
          assert.equal(lstatSync(path).mode & 0o777, 0o755);
          assert.equal(readFileSync(setup.log, 'utf8').includes('"tool":"run"'), false);
        }
      });
      await check('launch storage refuses directories owned by a different OS account', async () => {
        const setup = await fixture();
        const os = (await import('node:os')).default;
        const { syncBuiltinESMExports } = await import('node:module');
        const original = os.userInfo;
        try {
          // External account fault injection; filesystem ownership stays real.
          os.userInfo = (...args) => ({ ...original(...args), uid: original(...args).uid + 1 });
          syncBuiltinESMExports();
          await assert.rejects(launch(setup), (error) => error.code === 'HOST_AUTH_REQUIRED');
          assert.equal(readFileSync(setup.log, 'utf8').includes('"tool":"run"'), false);
        } finally { os.userInfo = original; syncBuiltinESMExports(); }
      });
      if (containedFixture) await check('fake systemd starts a real contained daemon and actual checkpoint readiness is required', async () => {
        const setup = await fixture();
        const ready = await launch(setup);
        assert.equal(ready.runId, setup.pins.runId);
        assert.equal(ready.state, 'running');
        assert.equal(ready.generation, 1);
        const checkpoint = readCheckpoint(setup.repository, ready.runId);
        assert.equal(processIdentityState(checkpoint.owner), 'alive');
        const calls = readFileSync(setup.log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
        const args = calls.find((call) => call.tool === 'run').args;
        assert(args.includes('--property=Restart=on-failure'));
        assert(args.includes('--property=MemoryMax=6442450944'));
        assert(args.includes('--property=MemorySwapMax=0'));
        assert(args.includes('--property=TasksMax=2048'));
        assert(!args.some((arg) => arg.includes('RuntimeMax')));
        assert(args.includes(setup.pins.nodePath));
        assert(args.includes(join(pluginRoot, 'tools', 'loop.mjs')));
        assert(args.includes(`--working-directory=${setup.repository.coordinatorRoot}`));
        const again = await launch(setup);
        assert.equal(again.alreadyRunning, true);
        assert.equal(readFileSync(setup.log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter((call) => call.tool === 'run').length, 1);
        const request = { schema: 'autoloop.control/2', requestId: randomUUID(), runId: ready.runId, kind: 'stop',
          target: { type: 'run', generation: ready.generation }, payload: {}, submittedAt: Date.now() };
        submitControl(setup.repository, actor(), request);
        await waitFor(() => JSON.parse(readFileSync(setup.state)).MainPID === '0', 'The daemon did not stop.');
        assert.equal(readCheckpoint(setup.repository, ready.runId).state, 'stopped');
      });
      if (containedFixture) await check('public host start survives its launcher, attaches a viewer and applies pause/resume/stop through real CLIs', async () => {
        const setup = await fixture({ publicCli: true });
        mkdirSync(join(setup.repository.coordinatorRoot, '.autoloop'));
        writeFileSync(join(setup.repository.coordinatorRoot, '.autoloop', 'config.json'), JSON.stringify(setup.pins.config));
        const bin = join(setup.home, 'bin'); mkdirSync(bin);
        // This is an external host executable, not a replacement admission gate.
        const hostPath = join(setup.home, 'claude');
        const { copyFileSync, symlinkSync } = await import('node:fs');
        copyFileSync(realpathSync(process.execPath), hostPath); symlinkSync(process.execPath, join(bin, 'claude'));
        const settings = { root: setup.repository.coordinatorRoot, pluginRoot, node: process.execPath, preload: setup.preload,
          accountHome: setup.accountHome, path: `${bin}:${process.env.PATH ?? ''}` };
        const script = `import assert from 'node:assert/strict'; import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto'; import {existsSync} from 'node:fs';
process.title='claude'; const settings=JSON.parse(process.argv[1]); const sessionId=randomUUID();
const call=(argv,input='')=>new Promise((done,fail)=>{const child=spawn(settings.node,['--import',settings.preload,...argv],
  {cwd:settings.root,env:{...process.env,PATH:settings.path,HOME:settings.accountHome},stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  child.once('error',fail);child.once('close',code=>{let json=null;try{json=JSON.parse(stdout);}catch{}
    done({code,json,stdout,stderr});});child.stdin.end(input);});
const loop=settings.pluginRoot+'/tools/loop.mjs';const status=settings.pluginRoot+'/tools/status.mjs';
let runId=null,generation=null;
const helper=async(operation,route='loop')=>{const request={schema:'autoloop.host-request/1',route,invocationId:randomUUID(),sessionId,
  root:settings.root,operation,runId:['start','disconnect'].includes(operation)?null:runId,
  requestId:['pause','resume','stop'].includes(operation)?randomUUID():null,generation:['start','disconnect'].includes(operation)?null:generation};
  const result=await call([settings.pluginRoot+'/tools/loop-host.mjs'],JSON.stringify(request));assert.equal(result.code,0,result.stdout+result.stderr);
  return {request,...result.json};};
const control=async(operation)=>{const issued=await helper(operation);const args=[loop,operation,'--root',settings.root,
  '--run',runId,'--request',issued.request.requestId,'--generation',String(generation),'--host-request','--json'];
  const accepted=await call(args,JSON.stringify(issued.envelope));assert.equal(accepted.code,0,accepted.stdout+accepted.stderr);
  assert.equal(accepted.json.data.status,'pending');const until=Date.now()+10000;
  while(Date.now()<until){const read=await call([loop,'request-status','--root',settings.root,'--run',runId,'--request',issued.request.requestId,'--json']);
    if(read.json?.data?.status==='applied')return read.json.data;await new Promise(done=>setTimeout(done,50));}
  throw Error('Control did not settle');};
const output={};try{
  output.unadmitted=await call([loop,'start','--root',settings.root,'--host-request','--json'],'{}');
  assert.equal(output.unadmitted.json.error.code,'HOST_AUTH_REQUIRED');
  output.model=await call([settings.pluginRoot+'/tools/loop-execution-admission.mjs','--guard-entry','command'],JSON.stringify({session_id:sessionId,
    cwd:settings.root,tool_name:'Bash',tool_input:{command:'node '+loop+' start --root '+settings.root+' --operator-terminal --json'}}));
  assert.equal(output.model.code,2);assert.equal(existsSync(settings.root+'/.git/autoloop/scheduler'),false);
  const issued=await helper('start');output.start=await call([loop,'start','--root',settings.root,'--host-request','--json'],JSON.stringify(issued.envelope));
  assert.equal(output.start.code,0,output.start.stdout+output.start.stderr);runId=output.start.json.data.runId;generation=output.start.json.data.generation;
  const attached=await helper('attach','status');output.attach=await call([status,'--attach','--root',settings.root,'--session',sessionId,
    '--run',runId,'--generation',String(generation),'--host-request'],JSON.stringify(attached.envelope));assert.equal(output.attach.code,0,output.attach.stdout+output.attach.stderr);
  output.view=await call([status,'--json','--root',settings.root,'--session',sessionId]);assert.equal(output.view.json.execution.queueEnabled,false);
  assert.equal(output.view.json.attachment.kind,'viewer');
  output.crossRun=await call([loop,'pause','--root',settings.root,'--run',randomUUID(),'--request',randomUUID(),'--generation',String(generation),'--host-request','--json'],'{}');
  assert.equal(output.crossRun.json.error.code,'RUN_MISMATCH');
  output.pause=await control('pause');output.paused=await call([loop,'status','--root',settings.root,'--json']);assert.equal(output.paused.json.data.state,'paused');
  output.resume=await control('resume');
  output.ended=await call([status,'--viewer-ended','--root',settings.root,'--session',sessionId]);assert.equal(output.ended.json.data.attached,false);
  output.surviving=await call([loop,'status','--root',settings.root,'--json']);assert.equal(output.surviving.json.data.state,'running');
  assert.equal(existsSync(settings.accountHome+'/.claude/autoloop/run-latches'),false);
  output.stop=await control('stop');process.send(output,()=>process.disconnect());
}catch(error){process.send({error:error.message,output},()=>process.disconnect());}`;
        const host = spawn(hostPath, ['--import', setup.preload, '--input-type=module', '-e', script, JSON.stringify(settings)], {
          detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, HOME: setup.accountHome },
        });
        const identity = readProcessIdentity(host.pid);
        const closed = new Promise((done) => host.once('close', done));
        let result;
        try {
          result = await new Promise((done, fail) => {
            const timer = setTimeout(() => fail(new Error('Public host integration timed out.')), 60000);
            let stderr = ''; host.stderr.on('data', (chunk) => { stderr += chunk; });
            host.once('message', (value) => { clearTimeout(timer); done(value); });
            host.once('close', (code) => { clearTimeout(timer); fail(new Error(`Host exited ${code}: ${stderr}`)); });
          });
          assert.equal(result.error, undefined, JSON.stringify(result));
          assert.equal(await closed, 0);
          const ready = result.start.json.data;
          assert.equal(ready.queueEnabled, false); assert.equal(ready.state, 'running');
          assert.equal(result.model.code, 2); assert.equal(result.attach.json.data.attached, true);
          await waitFor(() => JSON.parse(readFileSync(setup.state)).MainPID === '0', 'The admitted public daemon did not stop.');
          const checkpoint = readCheckpoint(setup.repository, ready.runId);
          assert.equal(checkpoint.state, 'stopped'); assert.equal(checkpoint.queueEnabled, false);
          assert.equal(checkpoint.initiator.process.pid, host.pid); assert.equal(checkpoint.initiator.kind, 'mod');
          const calls = readFileSync(setup.log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
          assert.equal(calls.filter((call) => call.tool === 'run').length, 1);
          assert.equal(calls.filter((call) => call.tool === 'spawn').length, 1);
          assert(calls.filter((call) => call.tool === 'show').every((call) => call.args[0] === '--user' && call.args[1] === 'show'));
          assert(existsSync(join(setup.accountHome, '.claude', 'autoloop', 'host-invocations')));
        } finally {
          if (processIdentityState(identity) === 'alive') host.kill('SIGKILL');
          await closed;
        }
      });
      if (containedFixture) await check('linked-worktree concurrent launches create only one named service owner', async () => {
        const setup = await fixture();
        const root = setup.repository.coordinatorRoot;
        assert.equal(spawnSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
          'commit', '--allow-empty', '-qm', 'base'], { encoding: 'utf8', timeout: 15000 }).status, 0);
        const linked = join(setup.home, 'linked');
        assert.equal(spawnSync('git', ['-C', root, 'worktree', 'add', '-q', '--detach', linked, 'HEAD'], { encoding: 'utf8', timeout: 15000 }).status, 0);
        const repository = resolveRepository(linked);
        const pins = createPins(repository, { pluginRoot, enginePath: setup.pins.enginePath, config: setup.pins.config, models: setup.pins.models });
        assert.equal(supervisorUnit(repository), supervisorUnit(setup.repository));
        const results = await Promise.allSettled([launch(setup), launch(setup, { repository, pins })]);
        assert.equal(results.filter((value) => value.status === 'fulfilled').length, 1);
        const refused = results.find((value) => value.status === 'rejected');
        assert.equal(refused.reason.code, 'SCHEDULER_ACTIVE');
        const calls = readFileSync(setup.log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
        assert.equal(calls.filter((call) => call.tool === 'spawn').length, 1);
        const checkpoint = readCurrentCheckpoint(setup.repository);
        const stop = { schema: 'autoloop.control/2', requestId: randomUUID(), runId: checkpoint.runId, kind: 'stop',
          target: { type: 'run', generation: checkpoint.generation }, payload: {}, submittedAt: Date.now() };
        submitControl(setup.repository, actor(), stop);
        await waitFor(() => JSON.parse(readFileSync(setup.state)).MainPID === '0', 'The single admitted daemon did not stop.');
      });
      if (containedFixture) await check('launcher exit leaves the daemon alive and unexpected failure resumes the same paused run', async () => {
        const setup = await fixture();
        const script = `const api = await import(process.argv[1]); const core = await import(process.argv[2]);
          const settings=JSON.parse(process.argv[3]); const result=await api.startSupervised({...settings,
            initiator:{kind:'terminal',sessionId:null,process:core.readProcessIdentity()}}); console.log(JSON.stringify(result));`;
        const launcher = spawn(process.execPath, ['--input-type=module', '-e', script, import.meta.url,
          new URL('./scheduler-contract.mjs', import.meta.url).href, JSON.stringify({ repository: setup.repository, pins: setup.pins,
            systemctlPath: setup.systemctlPath, systemdRunPath: setup.systemdRunPath, readinessTimeoutMs: 5000, pollMs: 25 })],
        { stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        let errors = '';
        launcher.stdout.on('data', (chunk) => { output += chunk; });
        launcher.stderr.on('data', (chunk) => { errors += chunk; });
        const code = await new Promise((done) => launcher.once('close', done));
        assert.equal(code, 0, errors);
        const ready = JSON.parse(output);
        let checkpoint = readCheckpoint(setup.repository, ready.runId);
        assert.equal(processIdentityState(checkpoint.owner), 'alive');
        const pause = { schema: 'autoloop.control/2', requestId: randomUUID(), runId: ready.runId, kind: 'pause',
          target: { type: 'run', generation: ready.generation }, payload: {}, submittedAt: Date.now() };
        submitControl(setup.repository, actor(), pause);
        await waitFor(() => readCheckpoint(setup.repository, ready.runId).state === 'paused', 'The supervised daemon did not pause.');
        checkpoint = readCheckpoint(setup.repository, ready.runId);
        const original = checkpoint.owner;
        assert.equal(processIdentityState(original), 'alive');
        process.kill(original.pid, 'SIGKILL');
        await waitFor(() => {
          try { const value = readCheckpoint(setup.repository, ready.runId); return value.generation === 2 && value.state === 'paused'; }
          catch (error) { if (error.code === 'RECOVERY_REQUIRED') return false; throw error; }
        }, 'The supervisor did not resume the paused run.');
        const resumed = readCheckpoint(setup.repository, ready.runId);
        assert.equal(resumed.runId, ready.runId);
        assert.equal(resumed.pinsDigest, checkpoint.pinsDigest);
        assert.notEqual(resumed.owner.pid, original.pid);
        assert.equal(processIdentityState(resumed.owner), 'alive');
        const stop = { ...pause, requestId: randomUUID(), kind: 'stop', target: { type: 'run', generation: 2 } };
        submitControl(setup.repository, actor(), stop);
        await waitFor(() => JSON.parse(readFileSync(setup.state)).MainPID === '0', 'The restarted daemon did not stop.');
        await new Promise((done) => setTimeout(done, 250));
        assert.equal(JSON.parse(readFileSync(setup.state)).MainPID, '0');
        assert.equal(readCheckpoint(setup.repository, ready.runId).state, 'stopped');
        assert.equal(readCheckpoint(setup.repository, ready.runId).generation, 2);
      });
      if (containedFixture) await check('supervisor retains stopped prepared intent until leased abandonment', async () => {
        const setup = await fixture();
        const owner = acquireScheduler(setup.repository, setup.pins, initiator());
        commitTransition(owner.lease, 1, (value) => ({ ...value, state: 'running' }));
        const operationId = randomUUID();
        prepareEffect(owner.lease, 2, { operationId, requestId: null, runId: setup.pins.runId, unitId: null, unitGeneration: null,
          kind: 'external.fixture', target: { type: 'external', id: randomUUID() }, inputDigest: schedulerDigest({ unstarted: true }),
          expectedHead: null, phase: 'prepared', attempt: 1, receipt: null, error: null });
        commitTransition(owner.lease, 3, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' })); releaseScheduler(owner.lease);
        const fresh = createPins(setup.repository, { pluginRoot, enginePath: setup.pins.enginePath, config: setup.pins.config, models: setup.pins.models });
        await assert.rejects(launch(setup, { pins: fresh }), (error) => error.code === 'RUN_MISMATCH');
        assert.equal(readCheckpoint(setup.repository, setup.pins.runId).outbox[operationId].phase, 'prepared');
        try { assert(['recovering', 'draining'].includes((await launch(setup)).state)); }
        catch (error) { assert.equal(error.code, 'READINESS_FAILED'); }
        await waitFor(() => JSON.parse(readFileSync(setup.state)).MainPID === '0', 'Prepared stopped recovery did not finish.');
        const retained = readCheckpoint(setup.repository, setup.pins.runId);
        assert.equal(retained.generation, 2);
        assert.equal(retained.outbox[operationId].phase, 'failed');
        assert.equal(retained.outbox[operationId].error.code, 'STOPPED_BEFORE_LAUNCH');
        const ready = await launch(setup, { pins: fresh });
        submitControl(setup.repository, actor(), { schema: 'autoloop.control/2', requestId: randomUUID(), runId: ready.runId,
          kind: 'stop', target: { type: 'run', generation: ready.generation }, payload: {}, submittedAt: Date.now() });
        await waitFor(() => JSON.parse(readFileSync(setup.state)).MainPID === '0', 'The fresh fixture run did not stop.');
      });
      if (containedFixture) await check('supervisor recovers stopped unknown work and refuses premature fresh-run launch', async () => {
        const setup = await fixture();
        const previous = acquireScheduler(setup.repository, setup.pins, initiator());
        commitTransition(previous.lease, 1, (value) => ({ ...value, state: 'running' }));
        const operationId = randomUUID();
        prepareEffect(previous.lease, 2, { operationId, requestId: null, runId: setup.pins.runId, unitId: null, unitGeneration: null,
          kind: 'external.fixture', target: { type: 'external', id: randomUUID() }, inputDigest: schedulerDigest({ retained: true }),
          expectedHead: null, phase: 'prepared', attempt: 1, receipt: null, error: null });
        markEffectInFlight(previous.lease, operationId);
        const current = readCheckpoint(setup.repository, setup.pins.runId);
        commitTransition(previous.lease, current.revision, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' }));
        releaseScheduler(previous.lease);
        const fresh = createPins(setup.repository, { pluginRoot, enginePath: setup.pins.enginePath, config: setup.pins.config, models: setup.pins.models });
        await assert.rejects(launch(setup, { pins: fresh }), (error) => error.code === 'RUN_MISMATCH');
        assert.equal(readFileSync(setup.log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).some((call) => call.tool === 'run'), false);
        // Retained stopped intent can finish immediately. Do not report it as running.
        let result;
        try { result = await launch(setup); }
        catch (error) { assert.equal(error.code, 'READINESS_FAILED'); }
        assert.notEqual(result?.state, 'running');
        await waitFor(() => JSON.parse(readFileSync(setup.state)).MainPID === '0', 'Retained stopped intent did not finish.');
        const recovered = readCheckpoint(setup.repository, setup.pins.runId);
        assert.equal(recovered.generation, 2);
        assert.equal(recovered.state, 'stopped');
        assert.equal(recovered.outbox[operationId].phase, 'unknown');
        assert.equal(recovered.error.code, 'OUTCOME_UNKNOWN');
      });
      await check('initiator fields cannot persist an environment or copied authority', async () => {
        const setup = await fixture();
        await assert.rejects(launch(setup, { initiator: { ...initiator(), environment: { token: 'fixture' } } }),
          (error) => error.code === 'HOST_AUTH_REQUIRED');
        assert.equal(existsSync(join(setup.repository.commonDir, 'autoloop')), false);
        assert.equal(readFileSync(setup.log, 'utf8'), '');
      });
      await check('matching service properties cannot hide ineffective kernel task limits', async () => {
        const setup = await fixture();
        const cgroup = readRegularFile('/proc/self/cgroup').trim().split('\n').find((line) => line.startsWith('0::')).slice(3);
        const actualTasks = readRegularFile(join('/sys/fs/cgroup', cgroup, 'pids.max')).trim();
        const tasksMax = actualTasks === '1024' ? 2048 : 1024;
        setup.pins = createPins(setup.repository, { pluginRoot, enginePath: setup.pins.enginePath,
          config: setup.pins.config, models: setup.pins.models, supervisorProfile: { ...DEFAULT_SUPERVISOR_PROFILE, tasksMax } });
        await assert.rejects(launch(setup), (error) => error.code === 'READINESS_FAILED');
        assert.equal(readCurrentCheckpoint(setup.repository), null);
        const service = JSON.parse(readFileSync(setup.state));
        assert.equal(service.TasksMax, String(tasksMax));
      });
      await check('supervised flags or copied environment cannot establish service authority', async () => {
        const setup = await fixture();
        const result = spawnSync(process.execPath, [join(ROOT, 'tools', 'loop.mjs'), 'run', '--supervised', '--root', setup.repository.coordinatorRoot,
          '--run', setup.pins.runId, '--launch-receipt', randomUUID()], { encoding: 'utf8', timeout: 15000,
          env: { ...process.env, INVOCATION_ID: randomUUID(), SYSTEMD_EXEC_PID: String(process.pid) } });
        assert.equal(result.status, 3);
        assert.equal(JSON.parse(result.stdout).error.code, 'HOST_AUTH_REQUIRED');
        assert.equal(existsSync(join(setup.repository.commonDir, 'autoloop', 'scheduler', 'lock')), false);
      });
      await check('an unavailable user manager refuses without a launch or foreground fallback', async () => {
        const setup = await fixture();
        writeFileSync(setup.mode, JSON.stringify({ unavailable: true }));
        await assert.rejects(launch(setup), (error) => error.code === 'SUPERVISOR_UNAVAILABLE');
        assert.equal(readFileSync(setup.log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).some((call) => call.tool === 'run'), false);
      });
      await check('ineffective limits and wrong MainPID cannot report readiness', async () => {
        for (const properties of [{ MemoryMax: 'infinity' }, { MemorySwapMax: '1' }, { TasksMax: 'infinity' }, { MainPID: String(process.pid) }, { RuntimeMaxUSec: '1000000' }]) {
          const setup = await fixture();
          writeFileSync(setup.mode, JSON.stringify({ properties }));
          await assert.rejects(launch(setup), (error) => error.code === 'READINESS_FAILED');
          assert.equal(readCurrentCheckpoint(setup.repository), null);
        }
      });
    }
    if (process.platform !== 'linux') console.error('SKIP Linux service lifecycle and cgroup tests on this host.');
    await check('unsupported daemon hosts never fall back to foreground', async () => {
      await assert.rejects(startSupervised({ platform: 'darwin' }), (error) => error.code === 'SUPERVISOR_UNAVAILABLE');
    });
  } finally {
    const stopped = await Promise.allSettled([...managers].map(async (manager) => {
      if (manager.connected) manager.send('stop');
      assert.equal(await manager.closed, 0, `The external test manager did not stop: ${manager.errors}`);
      for (const call of readFileSync(manager.log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)) {
        if (call.tool !== 'spawn') continue;
        assert.equal(processIdentityState(call.identity), 'dead', 'An owned test daemon is still live.');
        await waitFor(() => {
          try { process.kill(-call.identity.pid, 0); return false; }
          catch (error) { return error.code === 'ESRCH'; }
        }, 'An owned test daemon group remains.');
      }
    }));
    const cleanupFailure = stopped.find((value) => value.status === 'rejected');
    if (cleanupFailure) {
      console.error(`Retained supervisor test files: ${scratch}`);
      throw cleanupFailure.reason;
    }
    // Retain test files until removal is permitted in this execution context.
    console.error(`Retained supervisor test files: ${scratch}`);
  }
  const failed = results.filter(([, passed]) => !passed);
  console.log(failed.length === 0 ? `self-test OK (${results.length} cases)` : `self-test FAILED (${failed.length}/${results.length})`);
  return failed.length === 0;
}
const isMain = (() => {
  if (!process.argv[1]) return false;
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); }
  catch { return false; }
})();
if (isMain) {
  if (process.argv[2] === '--self-test') {
    try { process.exit(await selfTest(parseSupervisorSelfTestArgs(process.argv.slice(2))) ? 0 : 1); }
    catch (error) { console.error(error.message); }
  }
  console.error('usage: loop-supervisor.mjs --self-test [--require-supervision]');
  process.exit(2);
}
