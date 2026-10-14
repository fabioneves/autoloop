// Import-only allocation provider. The owner lease never leaves this process.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join, parse, relative, resolve } from 'node:path';
import * as scheduler from './scheduler-contract.mjs';
import { boundedGit } from './git-budget.mjs';
import { readGitStatus } from './git-observation.mjs';
import { parseLoopBranchIssue } from './claim-contract.mjs';
import { resolveProjectConfig } from './config-contract.mjs';

function requireCondition(passed, code, message) {
  if (!passed) throw new scheduler.SchedulerError(code, message);
}
function present(path) {
  try { lstatSync(path); return true; }
  catch (error) {
    if (error.code === 'ENOENT') return false;
    throw new scheduler.SchedulerError('WORKTREE_UNVERIFIED', 'A workspace path cannot be inspected.');
  }
}
function gitEnvironment() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')
    && !['NODE_OPTIONS', 'NODE_PATH'].includes(key)));
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
}
const GIT_OPTIONS = ['--no-lazy-fetch', '--no-replace-objects', '--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
function git(root, args) {
  const result = boundedGit([...GIT_OPTIONS, '-C', root, ...args], { env: gitEnvironment(), maxBuffer: 1024 * 1024 });
  requireCondition(result.status === 0 && !result.error, 'WORKTREE_UNVERIFIED', 'Workspace Git facts cannot be verified.');
  return result.stdout;
}
function regularText(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    requireCondition(fstatSync(fd).isFile(), 'WORKTREE_UNVERIFIED', 'A workspace record must be a regular file.');
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}
function realDirectory(path, { privateMode = false, owned = false } = {}) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try {
    const stat = fstatSync(fd);
    requireCondition(stat.isDirectory() && realpathSync(path) === path, 'WORKTREE_UNSAFE', 'Workspace ancestors must be real directories.');
    if (owned || privateMode) requireCondition(stat.uid === userInfo().uid && (stat.mode & (privateMode ? 0o077 : 0o022)) === 0,
      'WORKTREE_UNSAFE', 'Workspace directory ownership or permissions cannot be verified.');
  } finally { closeSync(fd); }
}
function ancestors(path) {
  const paths = [];
  for (let current = resolve(path);; current = dirname(current)) {
    paths.unshift(current);
    if (current === parse(current).root) return paths;
  }
}
function workspaceParents(context, intent, create = false) {
  const parent = dirname(context.pins.coordinatorRoot);
  requireCondition(![context.pins.coordinatorRoot, context.repository.commonDir].some((directory) => {
    const suffix = relative(directory, intent.root);
    return suffix === '' || !suffix.startsWith('..') && !suffix.startsWith('/');
  }), 'WORKTREE_UNSAFE', 'The workspace must be outside coordinator and administrative state.');
  try {
    for (const path of ancestors(parent)) realDirectory(path, { owned: path === parent });
    let directory = parent;
    for (const component of ['.autoloop-worktrees', intent.repositoryKey, intent.runId]) {
      directory = join(directory, component);
      if (!present(directory)) {
        if (!create) return;
        mkdirSync(directory, { mode: 0o700 });
        realDirectory(dirname(directory), { owned: true });
        const fd = openSync(dirname(directory), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
        try { fsyncSync(fd); } finally { closeSync(fd); }
      }
      realDirectory(directory, { privateMode: true });
    }
  } catch (error) {
    if (error instanceof scheduler.SchedulerError) throw error;
    throw new scheduler.SchedulerError('WORKTREE_UNSAFE', 'Workspace ancestors cannot be verified.');
  }
}
function registration(context, intent) {
  const fields = git(context.pins.coordinatorRoot, ['worktree', 'list', '--porcelain', '-z']).split('\0');
  const rows = []; let row = {};
  for (const field of fields) {
    if (field === '') { if (row.worktree) rows.push(row); row = {}; continue; }
    const separator = field.indexOf(' ');
    row[separator < 0 ? field : field.slice(0, separator)] = separator < 0 ? true : field.slice(separator + 1);
  }
  const roots = rows.filter((item) => item.worktree === intent.root);
  const branches = rows.filter((item) => item.branch === `refs/heads/${intent.branch}`);
  const refs = git(context.pins.coordinatorRoot, ['for-each-ref', '--format=%(refname)', `refs/heads/${intent.branch}`]).trim();
  return { roots, branches, refs };
}
function observeWorktree(context, allocation) {
  const { intent } = allocation;
  workspaceParents(context, intent);
  const registered = registration(context, intent);
  const rootExists = present(intent.root);
  if (!rootExists && registered.refs === '' && registered.roots.length === 0 && registered.branches.length === 0) {
    return { status: 'not-applied', facts: { intent, creator: allocation.creator, rootExists: false, branchExists: false, registered: false } };
  }
  requireCondition(rootExists && registered.roots.length === 1 && registered.branches.length === 1
    && registered.roots[0] === registered.branches[0] && registered.roots[0].HEAD === intent.baseOid
    && registered.refs === `refs/heads/${intent.branch}` && !registered.roots[0].locked && !registered.roots[0].prunable,
  'OUTCOME_UNKNOWN', 'The workspace or branch has partial or foreign state.');
  try {
    realDirectory(intent.root, { owned: true });
    const checkout = scheduler.resolveRepositoryCheckout(intent.root);
    requireCondition(checkout.root === intent.root && checkout.commonDir === context.repository.commonDir
      && checkout.repositoryKey === intent.repositoryKey && dirname(checkout.gitDir) === join(context.repository.commonDir, 'worktrees'),
    'WORKTREE_UNVERIFIED', 'The workspace administrative identity does not match its intent.');
    realDirectory(checkout.gitDir, { owned: true });
    requireCondition(regularText(join(intent.root, '.git')) === `gitdir: ${checkout.gitDir}\n`
      && regularText(join(checkout.gitDir, 'gitdir')) === `${join(intent.root, '.git')}\n`
      && realpathSync(resolve(checkout.gitDir, regularText(join(checkout.gitDir, 'commondir')).trim())) === checkout.commonDir,
    'WORKTREE_UNVERIFIED', 'The workspace administrative backlinks do not match.');
    requireCondition(git(intent.root, ['symbolic-ref', 'HEAD']).trim() === `refs/heads/${intent.branch}`
      && git(intent.root, ['rev-parse', '--verify', 'HEAD^{commit}']).trim() === intent.baseOid
      && readGitStatus(intent.root, { includeIgnored: true }).toString('utf8').trim() === '',
    'OUTCOME_UNKNOWN', 'The workspace is not clean at its exact creation base.');
    const worktree = { ...checkout, branch: intent.branch, baseOid: intent.baseOid, createdByRun: intent.runId,
      unitId: intent.unitId, unitGeneration: intent.unitGeneration };
    return { status: 'applied', worktree, facts: { intent, creator: allocation.creator, worktree, clean: true, headOid: intent.baseOid } };
  } catch (error) {
    if (error instanceof scheduler.SchedulerError) throw error;
    throw new scheduler.SchedulerError('WORKTREE_UNVERIFIED', 'The workspace readback cannot be verified.');
  }
}
function selectionUnit(context, unitId) {
  const unit = context.checkpoint.units.find((item) => item.unitId === unitId);
  const reservation = context.checkpoint.reservations.find((item) => item.unitId === unitId);
  requireCondition(unit && reservation && reservation.state !== 'released', 'TARGET_MISMATCH', 'The active selection unit does not exist.');
  return { unit, reservation };
}
function requireLaunch(context, baseOid) {
  requireCondition(context.checkpoint.state === 'running' && context.checkpoint.desiredState === 'running',
    'RUN_NOT_RUNNING', 'The run cannot start workspace creation.');
  requireCondition(scheduler.listControlRequests(context.repository, context.checkpoint.runId).length === 0
    && !Object.values(context.checkpoint.requests).some((item) => ['pending', 'processing', 'unknown'].includes(item.status)),
  'CONTROL_PENDING', 'An operator request must be processed before workspace creation.');
  const configured = resolveProjectConfig(context.pins.coordinatorRoot);
  requireCondition(configured?.ok && scheduler.schedulerDigest(configured.config) === context.pins.configDigest,
    'PINS_CHANGED', 'The pinned coordinator configuration changed.');
  requireCondition(git(context.pins.coordinatorRoot, ['rev-parse', '--verify', `refs/remotes/origin/${context.pins.baseBranch}^{commit}`]).trim() === baseOid,
    'BASE_CHANGED', 'Workspace creation requires the unchanged configured base OID.');
}

// Only this source and its private IPC channel can start the waiting child.
// It has no lease, no mutation CLI and no Git work before the owner's go signal.
const CREATOR_SOURCE = `import { spawnSync } from 'node:child_process';
const command = JSON.parse(process.argv[1]);
const timer = setTimeout(() => process.exit(2), 15000);
process.on('disconnect', () => process.exit(2));
process.once('message', message => {
  if (message !== command.operationId) process.exit(2);
  clearTimeout(timer);
  const result = spawnSync('git', command.args, { cwd: command.root, env: process.env, encoding: 'utf8',
    timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
  process.exit(result.status === 0 && !result.error ? 0 : 1);
});
process.send('ready');`;
function waitingCreator(context, intent) {
  const command = { operationId: intent.operationId, root: context.pins.coordinatorRoot,
    args: [...GIT_OPTIONS, '-C', context.pins.coordinatorRoot, 'worktree', 'add', '--no-track', '-b', intent.branch, intent.root, intent.baseOid] };
  const child = spawn(context.pins.nodePath, ['--input-type=module', '-e', CREATOR_SOURCE, JSON.stringify(command)], {
    cwd: context.pins.coordinatorRoot, env: gitEnvironment(), detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  // With ignored stdio, exit is the reap proof. Node can omit close after an
  // explicit IPC disconnect; there are no output streams to drain here.
  const exited = new Promise((done) => { child.once('exit', done); child.once('error', () => done(null)); });
  const ready = new Promise((done, fail) => {
    child.once('message', (message) => message === 'ready' ? done() : fail(new scheduler.SchedulerError('OWNER_UNVERIFIED', 'The creator readiness message is invalid.')));
    child.once('error', () => fail(new scheduler.SchedulerError('OWNER_UNVERIFIED', 'The creator cannot start.')));
    child.once('exit', () => fail(new scheduler.SchedulerError('OWNER_UNVERIFIED', 'The creator ended before readiness.')));
  });
  return { child, exited, ready };
}

// observe is test-only interruption instrumentation, not a Git/process substitute.
export function createWorktreeAllocator({ lease, scanRepository, observe = () => {} }) {
  const notify = (stage, facts) => observe(stage, structuredClone(facts));
  const reconcileWorktree = async (originalLease, unitId) => {
    requireCondition(originalLease === lease, 'LEASE_INVALID', 'The mutation requires the original owner lease.');
    const context = scheduler.readSchedulerContext(lease);
    const { unit, reservation } = selectionUnit(context, unitId);
    requireCondition(unit.allocation !== null, 'EFFECT_NOT_FOUND', 'The unit has no allocation intent.');
    const { allocation } = unit; const effect = context.checkpoint.outbox[allocation.intent.operationId];
    if (reservation.worktree) {
      const observed = observeWorktree(context, allocation);
      requireCondition(observed.status === 'applied'
        && scheduler.schedulerDigest(observed.worktree) === scheduler.schedulerDigest(reservation.worktree),
      'EVIDENCE_CHANGED', 'The saved worktree is missing or its administrative identity changed.');
      return reservation.worktree;
    }
    requireCondition(['in-flight', 'unknown'].includes(effect.phase), 'EFFECT_SETTLED', 'The allocation has no unresolved attempt.');
    requireCondition(allocation.creator !== null && scheduler.boundCreatorState(allocation.creator) === 'empty',
      'OWNER_UNVERIFIED', 'An unbound, live or unknown creator cannot prove an outcome.');
    const observed = observeWorktree(context, allocation);
    const receipt = { externalId: allocation.intent.operationId, observationDigest: scheduler.schedulerDigest(observed.facts), observedAt: Date.now() };
    scheduler.settleEffect(lease, allocation.intent.operationId, { attempt: effect.attempt, status: observed.status,
      code: observed.status === 'applied' ? 'WORKTREE_CREATED' : 'WORKTREE_NOT_APPLIED', receipt }, {
      transition: (checkpoint) => ({ ...checkpoint, reservations: checkpoint.reservations.map((item) => item.unitId === unitId && observed.worktree
        ? { ...item, worktree: observed.worktree } : item) }),
    });
    return observed.worktree ?? { status: 'not-applied', operationId: effect.operationId, attempt: effect.attempt };
  };
  const allocateWorktree = async (originalLease, unitId, baseOid) => {
    requireCondition(originalLease === lease, 'LEASE_INVALID', 'The mutation requires the original owner lease.');
    let context = scheduler.readSchedulerContext(lease);
    let { unit, reservation } = selectionUnit(context, unitId);
    requireCondition(typeof baseOid === 'string' && baseOid === reservation.baseOid, 'BASE_CHANGED', 'Allocation must keep the reserved base OID.');
    if (unit.allocation && ['in-flight', 'unknown', 'succeeded'].includes(context.checkpoint.outbox[unit.allocation.intent.operationId].phase)) {
      const result = await reconcileWorktree(originalLease, unitId);
      if (result.status !== 'not-applied') return result;
      context = scheduler.readSchedulerContext(lease); ({ unit, reservation } = selectionUnit(context, unitId));
    }
    requireLaunch(context, baseOid);
    if (!unit.allocation) {
      const intent = { operationId: randomUUID(), runId: context.checkpoint.runId, unitId, unitGeneration: unit.unitGeneration,
        repositoryKey: context.repository.repositoryKey,
        root: join(dirname(context.pins.coordinatorRoot), '.autoloop-worktrees', context.repository.repositoryKey, context.checkpoint.runId, `${unitId}-g${unit.unitGeneration}`),
        branch: `feat/gh-${reservation.issue}-unit-${unitId.replaceAll('-', '')}-g${unit.unitGeneration}`, baseOid };
      requireCondition(parseLoopBranchIssue(intent.branch) === reservation.issue, 'WORKTREE_UNSAFE', 'The derived branch must name its issue.');
      const allocation = { intent, creator: null, creatorHistory: [] };
      requireCondition(observeWorktree(context, allocation).status === 'not-applied', 'WORKTREE_CONFLICT', 'The derived workspace or branch already exists.');
      const revision = context.checkpoint.revision;
      const reference = await scanRepository({ root: context.pins.coordinatorRoot, pins: context.pins });
      if (reference?.ok === false) throw new scheduler.SchedulerError(reference.error.code, reference.error.message);
      context = scheduler.readSchedulerContext(lease);
      requireCondition(context.checkpoint.revision === revision, 'REVISION_MISMATCH', 'The checkpoint changed during allocation evidence collection.');
      requireCondition(reference.baseOid === baseOid, 'BASE_CHANGED', 'The configured base changed during allocation evidence collection.');
      requireLaunch(context, baseOid);
      requireCondition(observeWorktree(context, allocation).status === 'not-applied', 'WORKTREE_CONFLICT', 'The allocation target changed.');
      scheduler.prepareEffect(lease, revision, { operationId: intent.operationId, requestId: null, runId: intent.runId, unitId,
        unitGeneration: unit.unitGeneration, kind: 'worktree.create', target: { type: 'external', id: unitId }, inputDigest: scheduler.schedulerDigest(intent),
        expectedHead: baseOid, phase: 'prepared', attempt: 1, receipt: null, error: null }, (checkpoint) => ({ ...checkpoint,
        units: checkpoint.units.map((item) => item.unitId === unitId ? { ...item, allocation, checkedSnapshot: reference } : item) }));
      await notify('prepared', { intent });
      context = scheduler.readSchedulerContext(lease); ({ unit } = selectionUnit(context, unitId));
    }
    const { intent } = unit.allocation;
    requireCondition(context.checkpoint.outbox[intent.operationId].phase === 'prepared' && unit.allocation.creator === null,
      'OUTCOME_UNKNOWN', 'This allocation cannot launch another creator.');
    requireCondition(observeWorktree(context, unit.allocation).status === 'not-applied', 'OUTCOME_UNKNOWN', 'The prepared allocation target is not absent.');
    workspaceParents(context, intent, true);
    const waiting = waitingCreator(context, intent);
    try {
      await waiting.ready;
      const identity = scheduler.readProcessIdentity(waiting.child.pid);
      const creator = { process: identity, pgid: waiting.child.pid, groupLeader: identity };
      requireCondition(scheduler.boundCreatorState(creator) === 'alive', 'OWNER_UNVERIFIED', 'The creator group cannot be verified.');
      await notify('ready', { intent, creator });
      context = scheduler.readSchedulerContext(lease); requireLaunch(context, baseOid);
      scheduler.markEffectInFlight(lease, intent.operationId);
      await notify('in-flight', { intent, creator });
      context = scheduler.readSchedulerContext(lease);
      scheduler.commitTransition(lease, context.checkpoint.revision, (checkpoint) => ({ ...checkpoint,
        units: checkpoint.units.map((item) => item.unitId === unitId ? { ...item, allocation: { ...item.allocation, creator } } : item) }));
      await notify('bound', { intent, creator });
      context = scheduler.readSchedulerContext(lease); requireLaunch(context, baseOid);
      requireCondition(scheduler.boundCreatorState(creator) === 'alive', 'OWNER_UNVERIFIED', 'The bound creator must still be live before creation.');
      requireCondition(observeWorktree(context, selectionUnit(context, unitId).unit.allocation).status === 'not-applied',
        'OUTCOME_UNKNOWN', 'The target changed before creation.');
      waiting.child.send(intent.operationId);
      await waiting.exited;
      await notify('created', { intent, creator });
    } finally {
      // Disconnect before go makes the trusted waiting child exit without Git.
      if (waiting.child.connected) waiting.child.disconnect();
      await waiting.exited;
    }
    return reconcileWorktree(originalLease, unitId);
  };
  return Object.freeze({ allocateWorktree, reconcileWorktree });
}
