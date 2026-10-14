#!/usr/bin/env node
// Synthetic selection only. No worker launch or GitHub mutation entry point.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as scheduler from './scheduler-contract.mjs';
import { resolveConfigText, resolveProjectConfig } from './config-contract.mjs';
import { DEFAULT_MODELS, mergeModels } from './models-config.mjs';
import { boundedGit } from './git-budget.mjs';
import { parseGitHubRemote } from './checkout-contract.mjs';
import { repositorySnapshotWithSources } from './scan.mjs';
import { deliveredPullRequests, eligibleIssueNumbers, haltIssueNumbers, markerSchedule, SNAPSHOT_SECTIONS, unitCard, verifySnapshot } from './snapshot-contract.mjs';
import { issueAuthorizationEvidence, validateIssueAuthorization, validateIssueAuthorizationEvidence } from './scheduler-selection-schema.mjs';
import { serializeLifecycleMarker } from './lifecycle-contract.mjs';
import { createWorktreeAllocator } from './scheduler-worktree.mjs';

const equal = (left, right) => scheduler.schedulerDigest(left) === scheduler.schedulerDigest(right);
function refusal(code, message) {
  return { schema: 'autoloop.loop/1', ok: false, error: { code, message } };
}
function requireCondition(passed, code, message) {
  if (!passed) throw new scheduler.SchedulerError(code, message);
}
function requestObject(value) {
  requireCondition(value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'INVALID_INPUT', 'A selection request must be an object.');
  return value;
}
function localGit(root, args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' });
  const result = boundedGit(['--no-replace-objects', '--no-optional-locks', '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false', '-C', root, ...args], { env, maxBuffer: 1024 * 1024 });
  requireCondition(result.status === 0 && !result.error, 'REPOSITORY_INVALID', 'The requested checkout facts cannot be verified.');
  return result.stdout.trim();
}
function completeEvidence(snapshot, sources) {
  requireCondition(verifySnapshot(snapshot) && snapshot.invalidation.reasonCodes.length === 0
    && SNAPSHOT_SECTIONS.every((name) => snapshot.sections[name].complete)
    && sources.waitIssues.complete && sources.waitPullRequests.complete,
  'EVIDENCE_INCOMPLETE', 'Selection requires complete current evidence.');
}
function waitReferences(checkpoint) {
  const issues = new Set(); const pullRequests = new Set();
  for (const unit of checkpoint.units) for (const condition of unit.wait?.condition.all ?? []) {
    if (condition.on === 'issue') issues.add(condition.number);
    if (condition.on === 'pr') pullRequests.add(condition.number);
  }
  return { issues: [...issues].sort((a, b) => a - b), pullRequests: [...pullRequests].sort((a, b) => a - b) };
}
function requireSameRepository(checkpoint, repository) {
  for (const reservation of checkpoint.reservations) if (reservation.state !== 'released') {
    requireCondition(equal(reservation.issueAuthorization.subject.repository, repository), 'EVIDENCE_CHANGED',
      'Retained work belongs to another upstream repository.');
  }
}
function authorizeIssue(evidence, reference, number) {
  const { snapshot, sources } = evidence;
  const queue = snapshot.sections.queue.items.find((item) => item.number === number);
  const source = sources.approvals.find((item) => item.issue === number);
  const role = sources.roles.find((item) => item.login === source?.actorLogin);
  const issue = sources.issues.find((item) => item.number === number);
  if (!queue || !source || !role || !issue) return null;
  const subject = { repositoryKey: reference.repositoryKey, repository: reference.repository, issue: number, issueNodeId: issue.nodeId,
    issueBodyDigest: createHash('sha256').update(queue.body, 'utf8').digest('hex'),
    approval: { kind: source.kind, issue: source.approvalIssue, issueNodeId: source.approvalIssueNodeId, eventId: source.eventId,
      actorLogin: source.actorLogin, actorUserId: role.userId, createdAt: source.createdAt } };
  const authorization = { schema: 'autoloop.issue-authorization/1', subject, authorizationDigest: scheduler.schedulerDigest(subject),
    evidenceDigest: '0'.repeat(64), snapshot: reference };
  const tuple = issueAuthorizationEvidence(authorization, evidence);
  if (tuple === null) return null;
  authorization.evidenceDigest = scheduler.schedulerDigest(tuple);
  return authorization;
}
function recoveryCandidates(evidence, checkpoint) {
  const candidates = [];
  const active = checkpoint.reservations.filter((item) => item.state !== 'released');
  for (const reservation of active) candidates.push({ kind: 'unit', unitId: reservation.unitId, issue: reservation.issue,
    state: reservation.state, gating: checkpoint.state === 'recovering' || reservation.state === 'recovering' });
  for (const worker of checkpoint.workers) candidates.push({ kind: 'worker', attemptId: worker.attemptId, unitId: worker.unitId,
    gating: !checkpoint.units.some((unit) => unit.unitId === worker.unitId) || worker.generation < checkpoint.generation
      || scheduler.boundGroupState(worker) !== 'empty' });
  for (const effect of Object.values(checkpoint.outbox).sort((a, b) => a.operationId.localeCompare(b.operationId))) {
    if (!['succeeded', 'failed'].includes(effect.phase)) candidates.push({ kind: 'effect', operationId: effect.operationId, gating: true });
  }
  const { snapshot } = evidence;
  const delivered = deliveredPullRequests(snapshot);
  const deliveredIssues = new Set(delivered.map((item) => item.issue));
  const schedule = markerSchedule(snapshot);
  for (const issue of [...schedule.gating, ...schedule.deferred]) if (!deliveredIssues.has(issue)) {
    candidates.push({ kind: 'lifecycle', issue, gating: schedule.gating.includes(issue) });
  }
  for (const pr of snapshot.sections.openPrs.items) {
    if (!delivered.some((item) => item.pr === pr.number) && (pr.ownership === 'loop' || pr.orphanCandidate)) {
      candidates.push({ kind: pr.orphanCandidate ? 'orphan' : pr.isDraft ? 'draft' : 'pull-request', number: pr.number, issue: pr.issue, gating: true });
    }
  }
  for (const pr of delivered) candidates.push({ kind: 'delivered', number: pr.pr, issue: pr.issue, paths: pr.files, gating: false });
  for (const issue of snapshot.sections.openIssues.items) if (issue.labels.includes('loop-waiting')) {
    candidates.push({ kind: 'waiting', issue: issue.number, gating: false });
  }
  return candidates;
}
function controlPending(repository, checkpoint) {
  return scheduler.listControlRequests(repository, checkpoint.runId).length > 0
    || Object.values(checkpoint.requests).some((item) => ['pending', 'processing', 'unknown'].includes(item.status));
}
function requireSelectionOpen(repository, checkpoint) {
  requireCondition(checkpoint.state === 'running' && checkpoint.desiredState === 'running', 'RUN_NOT_RUNNING', 'The run does not accept new issues.');
  requireCondition(!controlPending(repository, checkpoint), 'CONTROL_PENDING', 'An operator request must be processed before selection.');
}

// Capture the actual process-bound lease. Later modules can add allocation and
// admission methods here through their trusted helpers; no substitute exists.
export function createSelectionProvider({ lease }) {
  const boundary = (action) => async (...args) => {
    try { return await action(...args); }
    catch (error) {
      if (!(error instanceof scheduler.SchedulerError)) throw error;
      return refusal(error.code, error.message);
    }
  };
  const scan = async (request = {}) => {
    const { root, pins } = requestObject(request);
    const context = scheduler.readSchedulerContext(lease);
    if (pins !== undefined) requireCondition(equal(pins, context.pins), 'PINS_CHANGED', 'The requested pins do not match this run.');
    const checkout = scheduler.resolveRepositoryCheckout(root ?? context.pins.coordinatorRoot);
    requireCondition(checkout.repositoryKey === context.repository.repositoryKey && checkout.commonDir === context.repository.commonDir,
      'REPOSITORY_INVALID', 'The requested checkout belongs to another repository.');
    const configured = resolveProjectConfig(context.pins.coordinatorRoot);
    requireCondition(configured?.ok && scheduler.schedulerDigest(configured.config) === context.pins.configDigest,
      'PINS_CHANGED', 'The pinned coordinator configuration changed.');
    const origins = localGit(checkout.root, ['config', '--get-all', 'remote.origin.url']).split(/\r?\n/u);
    const origin = origins.length === 1 ? parseGitHubRemote(origins[0]) : null;
    requireCondition(origin !== null, 'REPOSITORY_INVALID', 'The requested checkout needs one canonical origin.');
    const baseRef = `refs/remotes/origin/${context.pins.baseBranch}`;
    const baseOid = localGit(checkout.root, ['rev-parse', '--verify', `${baseRef}^{commit}`]);
    const headOid = localGit(checkout.root, ['rev-parse', '--verify', 'HEAD^{commit}']);
    const { snapshot, sources } = await repositorySnapshotWithSources({ root: checkout.root, references: waitReferences(context.checkpoint) });
    completeEvidence(snapshot, sources);
    requireCondition(sources.repository?.nodeId && sources.repository.host === origin.host
      && sources.repository.owner.toLowerCase() === origin.owner && sources.repository.name.toLowerCase() === origin.repo,
    'EVIDENCE_INVALID', 'The collector repository does not match the requested origin.');
    requireSameRepository(context.checkpoint, sources.repository);
    const evidence = { schema: 'autoloop.selection-snapshot/1', runId: context.checkpoint.runId, generation: context.checkpoint.generation,
      checkpointRevision: context.checkpoint.revision, ...checkout, repository: sources.repository,
      configuredBaseBranch: context.pins.baseBranch, baseRef, baseOid, headOid, configDigest: context.pins.configDigest, snapshot, sources };
    return scheduler.publishSelectionSnapshot(lease, context.checkpoint.revision, evidence);
  };
  const inventory = (request = {}) => {
    const { snapshot: reference, checkpoint } = requestObject(request);
    const context = scheduler.readSchedulerContext(lease);
    requireCondition(scheduler.validateCheckpoint(checkpoint).length === 0, 'INVALID_INPUT', 'The inventory needs a valid checkpoint.');
    requireCondition(equal(checkpoint, context.checkpoint), 'REVISION_MISMATCH', 'The inventory checkpoint changed.');
    const evidence = scheduler.readSelectionSnapshot(lease, reference);
    requireSameRepository(context.checkpoint, evidence.repository);
    const candidates = recoveryCandidates(evidence, context.checkpoint);
    const accepting = context.checkpoint.state === 'running' && context.checkpoint.desiredState === 'running'
      && !controlPending(context.repository, context.checkpoint);
    if (!accepting || candidates.some((item) => item.gating)) return candidates;
    const excluded = new Set(candidates.filter((item) => item.issue !== null && item.issue !== undefined).map((item) => item.issue));
    for (const issue of eligibleIssueNumbers(evidence.snapshot)) if (!excluded.has(issue)) {
      const issueAuthorization = authorizeIssue(evidence, reference, issue);
      if (issueAuthorization === null) {
        candidates.push({ kind: 'refusal', issue, gating: false,
          refusal: refusal('AUTHORIZATION_INVALID', 'The issue needs complete matching upstream source evidence.') });
      } else candidates.push({ kind: 'issue', issue, issueAuthorization, gating: false });
    }
    return candidates;
  };
  const reserve = async (originalLease, expectedRevision, proposed) => {
    requireCondition(originalLease === lease, 'LEASE_INVALID', 'The mutation requires the original owner lease.');
    const context = scheduler.readSchedulerContext(lease);
    requireCondition(context.checkpoint.revision === expectedRevision, 'REVISION_MISMATCH', 'The checkpoint revision changed.');
    requireSelectionOpen(context.repository, context.checkpoint);
    requireCondition(validateIssueAuthorization(proposed).length === 0, 'AUTHORIZATION_INVALID', 'The proposed authorization is invalid.');
    // Caller objects can change during the scan. Retain their value, not their identity.
    const authorization = structuredClone(proposed);
    const originalEvidence = scheduler.readSelectionSnapshot(lease, authorization.snapshot, { current: false });
    requireCondition(validateIssueAuthorizationEvidence(authorization, originalEvidence).length === 0,
      'AUTHORIZATION_INVALID', 'The proposal does not match retained collector evidence.');
    const reference = await scan({ root: authorization.snapshot.root, pins: context.pins });
    const current = scheduler.readSchedulerContext(lease);
    requireCondition(current.checkpoint.revision === expectedRevision, 'REVISION_MISMATCH', 'The checkpoint revision changed during selection.');
    requireSelectionOpen(current.repository, current.checkpoint);
    const evidence = scheduler.readSelectionSnapshot(lease, reference);
    const freshAuthorization = authorizeIssue(evidence, reference, authorization.subject.issue);
    requireCondition(freshAuthorization !== null && equal(freshAuthorization.subject, authorization.subject),
      'AUTHORIZATION_REVOKED', 'The upstream approval, role or issue body no longer authorizes this proposal.');
    const unitId = randomUUID();
    const committed = scheduler.commitTransition(lease, expectedRevision, (checkpoint) => {
      requireSelectionOpen(current.repository, checkpoint);
      const checked = scheduler.readSelectionSnapshot(lease, reference);
      requireSameRepository(checkpoint, checked.repository);
      requireCondition(haltIssueNumbers(checked.snapshot).length === 0, 'RUN_HALTED', 'A halt issue prevents new selection.');
      requireCondition(!recoveryCandidates(checked, checkpoint).some((item) => item.gating), 'RECOVERY_REQUIRED', 'Retained recovery must be processed before new selection.');
      const issue = authorization.subject.issue;
      requireCondition(!checkpoint.reservations.some((item) => item.state !== 'released' && item.issue === issue),
        'ISSUE_RESERVED', 'This issue already has a reservation.');
      requireCondition(unitCard(checked.snapshot, issue).eligible === true, 'AUTHORIZATION_REVOKED', 'This issue is no longer eligible.');
      const occupied = new Set(checkpoint.reservations.filter((item) => item.state !== 'released').map((item) => item.slot));
      const slot = [1, 2].find((value) => !occupied.has(value));
      requireCondition(slot !== undefined, 'SLOTS_FULL', 'Both selection slots are retained.');
      const reservation = { schema: 'autoloop.reservation/1', runId: checkpoint.runId, unitId, unitGeneration: 1, issue,
        repositoryKey: checkpoint.repositoryKey, issueAuthorization: authorization, slot, baseOid: checked.baseOid,
        worktree: null, paths: [], state: 'planning', createdRevision: checkpoint.revision + 1 };
      const unit = { schema: 'autoloop.selection-unit/1', runId: checkpoint.runId, repositoryKey: checkpoint.repositoryKey, unitId, unitGeneration: 1,
        allocation: null, plan: null, admission: null, wait: null, checkedSnapshot: reference, replanRequired: false, policy: { authorize: [] }, disposition: null };
      return { ...checkpoint, reservations: [...checkpoint.reservations, reservation], units: [...checkpoint.units, unit] };
    });
    return committed.reservations.find((item) => item.unitId === unitId);
  };
  const allocation = createWorktreeAllocator({ lease, scanRepository: scan });
  return Object.freeze({ scanRepository: boundary(scan), inventoryRecovery: boundary(inventory), reserveIssue: boundary(reserve),
    allocateWorktree: boundary(allocation.allocateWorktree), reconcileWorktree: boundary(allocation.reconcileWorktree) });
}

// Only the external GitHub boundary is replaced. The collector and Git run unchanged.
async function fakeGitHub() {
  const fs = await import('node:fs');
  const data = JSON.parse(fs.readFileSync(process.env.SELECTION_FIXTURE, 'utf8'));
  const repo = data[process.cwd()];
  assert(repo, 'The request must use a fixture checkout.');
  assert.equal(process.env.GH_REPO, 'github.com/fixtures/selection');
  assert.equal(process.env.GH_HOST, 'github.com');
  const page = (nodes) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
  const at = '2026-01-01T00:00:00Z';
  const args = process.argv.slice(2);
  const send = (value) => process.stdout.write(JSON.stringify(value));
  if (args[0] === 'repo') {
    send({ id: 'R_selection', nameWithOwner: repo.apiCase ? 'Fixtures/Selection' : 'fixtures/selection', defaultBranchRef: { name: 'default-not-configured' } });
    return;
  }
  if (args.some((arg) => arg.endsWith('/permission'))) {
    send({ permission: repo.permission ?? 'write', role_name: 'maintain', user: { login: 'maintainer', id: 101 } });
    return;
  }
  const { query, variables } = JSON.parse(fs.readFileSync(0, 'utf8'));
  const issue = (number) => ({ id: repo.missingIds || repo.missingIdNumber === number ? null : `I_${number}`, number, title: `Issue ${number}`,
    body: repo.body ?? 'Fixture body.\n', updatedAt: at, lastEditedAt: repo.edited ? '2026-01-02T00:00:00Z' : null,
    labels: page([{ name: 'loop-ready' }, ...(repo.halt && number === 7 ? [{ name: 'loop-halt' }] : [])]) });
  const event = (number) => ({ __typename: 'LabeledEvent', id: repo.missingIds || repo.missingIdNumber === number ? null : `E_${number}`,
    actor: { login: 'maintainer' }, createdAt: at, label: { name: 'loop-ready' } });
  let repository;
  if (query.includes('issues(states:OPEN')) {
    if (repo.barrier) {
      fs.writeFileSync(repo.barrier.entered, 'entered');
      while (!fs.existsSync(repo.barrier.release)) await new Promise((done) => setTimeout(done, 10));
    }
    if (repo.incomplete) { send({ errors: [{ message: 'Fixture inventory unavailable' }] }); return; }
    const openNumbers = repo.openNumbers ?? [7, 8, 9];
    repository = { issues: page(openNumbers.map(issue)) };
  } else if (query.includes('pullRequests(states:')) repository = { pullRequests: page(variables.states.includes('OPEN') ? repo.prs ?? [] : repo.mergedPrs ?? []) };
  else if (/i\d+:issue/u.test(query)) {
    repository = {};
    for (const [, alias, raw] of query.matchAll(/(i(\d+)):issue/gu)) {
      const number = Number(raw);
      repository[alias] = { __typename: 'Issue', number, state: repo.dependencyOpen ? 'OPEN' : 'CLOSED',
        comments: page(repo.comments?.[number] ?? []), timelineItems: page([event(number)]) };
    }
  } else if (query.includes('timelineItems(')) repository = { issue: { timelineItems: page([event(variables.number)]) } };
  else if (query.includes('issue(number:')) repository = { issue: { id: `I_${variables.number}`, number: variables.number, state: 'OPEN', comments: page([]) } };
  else if (query.includes('reviewThreads(')) repository = { pullRequest: { reviewThreads: page([]) } };
  else if (query.includes('reviews(')) repository = { pullRequest: { reviews: page([]) } };
  else if (query.includes('comments(')) repository = { pullRequest: { comments: page([]) } };
  else throw new Error('The fixture received an unsupported GitHub query.');
  send({ data: { repository } });
}

async function selfTest() {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'scheduler-selection-')));
  const account = await scheduler.createSchedulerTestAccount(scratch);
  const originalPath = process.env.PATH;
  const originalFixture = process.env.SELECTION_FIXTURE;
  const fixtures = {};
  const fixturePath = join(scratch, 'github.json');
  const results = [];
  const owned = [];
  const children = new Set();
  const git = (root, ...args) => {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout.trim();
  };
  const update = (root, facts = {}) => {
    fixtures[root] = { ...facts };
    writeFileSync(fixturePath, JSON.stringify(fixtures));
  };
  const check = async (name, action) => {
    try { await action(); results.push([name, true]); }
    catch (error) { console.error(`FAIL ${name}: ${error.stack}`); results.push([name, false]); }
  };
  const refuses = (result, code) => {
    assert.equal(result.schema, 'autoloop.loop/1');
    assert.equal(result.ok, false);
    if (code) assert.equal(result.error.code, code);
    assert.equal(typeof result.error.message, 'string');
  };
  const fixture = ({ base = true, acquire = true } = {}) => {
    assert(userInfo().homedir.startsWith(`${scratch}/`), 'The account must be isolated before acquisition.');
    const home = join(scratch, randomUUID()); mkdirSync(home);
    const root = join(home, 'repo'); mkdirSync(root);
    git(root, 'init', '-q', '-b', 'main');
    writeFileSync(join(root, 'tracked.txt'), 'creation base\n'); git(root, 'add', 'tracked.txt');
    git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base');
    git(root, 'remote', 'add', 'origin', 'https://github.com/fixtures/selection.git');
    const baseOid = git(root, 'rev-parse', 'HEAD');
    if (base) git(root, 'update-ref', 'refs/remotes/origin/main', baseOid);
    const config = resolveConfigText(JSON.stringify({ version: '0.28.0', baseBranch: 'main', gate: { command: 'node --version' } })).config;
    mkdirSync(join(root, '.autoloop')); writeFileSync(join(root, '.autoloop', 'config.json'), JSON.stringify(config));
    const pluginRoot = join(home, 'plugin'); mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true });
    writeFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
    const repository = scheduler.resolveRepository(root);
    const pins = scheduler.createPins(repository, { pluginRoot, enginePath: realpathSync(process.execPath), config, models: mergeModels(DEFAULT_MODELS) });
    update(root);
    if (!acquire) return { home, root, repository, pins, baseOid };
    const acquired = scheduler.acquireScheduler(repository, pins, { kind: 'terminal', sessionId: null, process: scheduler.readProcessIdentity() });
    owned.push({ repository, ...acquired });
    scheduler.commitTransition(acquired.lease, 1, (checkpoint) => ({ ...checkpoint, state: 'running' }));
    const provider = createSelectionProvider({ lease: acquired.lease });
    return { home, root, repository, pins, baseOid, ...acquired, provider,
      checkpoint: () => scheduler.readCheckpoint(repository, acquired.runId) };
  };
  const discover = async (setup, number = 7) => {
    const reference = await setup.provider.scanRepository({ root: setup.root, pins: setup.pins });
    assert.equal(reference.schema, 'autoloop.snapshot-reference/1', JSON.stringify(reference));
    const candidates = await setup.provider.inventoryRecovery({ snapshot: reference, checkpoint: setup.checkpoint() });
    assert(Array.isArray(candidates), JSON.stringify(candidates));
    const candidate = candidates.find((item) => item.kind === 'issue' && item.issue === number);
    assert(candidate, JSON.stringify(candidates));
    return candidate.issueAuthorization;
  };
  try {
    const bin = join(scratch, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), `#!${process.execPath}\nimport assert from 'node:assert/strict';\n(${fakeGitHub.toString()})().catch(error=>{console.error(error.message);process.exitCode=1;});\n`, { mode: 0o700 });
    process.env.PATH = `${bin}:${originalPath}`; process.env.SELECTION_FIXTURE = fixturePath;
    await check('the facade exists and has no production queue or mutation CLI', async () => {
      assert.equal(typeof createSelectionProvider, 'function', 'The selection facade must exist.');
      const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--reserve', '7'], { encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, 2);
      const imported = spawnSync(process.execPath, ['--input-type=module', '-e', 'await import(process.argv[1]);', import.meta.url],
        { encoding: 'utf8', timeout: 5000 });
      assert.equal(imported.status, 0, imported.stderr);
      const { UNIVERSAL_TOOL_FILES } = await import('./verify.mjs');
      assert(UNIVERSAL_TOOL_FILES.includes('scheduler-selection.mjs'));
    });
    await check('complete actual collector evidence reserves an immutable pair without changing coordinator Git', async () => {
      const setup = fixture();
      const before = [git(setup.root, 'symbolic-ref', 'HEAD'), git(setup.root, 'rev-parse', 'HEAD'), git(setup.root, 'status', '--porcelain=v1'), git(setup.root, 'rev-parse', 'refs/remotes/origin/main')];
      const authorization = await discover(setup);
      refuses(await setup.provider.scanRepository(null), 'INVALID_INPUT');
      refuses(await setup.provider.inventoryRecovery(null), 'INVALID_INPUT');
      refuses(await setup.provider.inventoryRecovery({ snapshot: authorization.snapshot }), 'INVALID_INPUT');
      refuses(await setup.provider.inventoryRecovery({ snapshot: authorization.snapshot,
        checkpoint: { ...setup.checkpoint(), revision: setup.checkpoint().revision + 1 } }), 'REVISION_MISMATCH');
      assert.equal(authorization.subject.issueNodeId, 'I_7');
      assert.equal(authorization.subject.approval.eventId, 'E_7');
      assert.equal(authorization.subject.approval.actorUserId, 101);
      const reservation = await setup.provider.reserveIssue(setup.lease, setup.checkpoint().revision, authorization);
      assert.equal(reservation.schema, 'autoloop.reservation/1', JSON.stringify(reservation));
      assert.equal(reservation.slot, 1); assert.equal(reservation.worktree, null); assert.deepEqual(reservation.paths, []);
      const checkpoint = setup.checkpoint();
      assert.equal(checkpoint.schema, 'autoloop.scheduler-checkpoint/1'); assert.equal(checkpoint.queueEnabled, false);
      assert.deepEqual(checkpoint.reservations, [reservation]); assert.deepEqual(reservation.issueAuthorization, authorization);
      assert.equal(checkpoint.units[0].checkedSnapshot.checkpointRevision, checkpoint.revision - 1);
      assert.deepEqual([git(setup.root, 'symbolic-ref', 'HEAD'), git(setup.root, 'rev-parse', 'HEAD'), git(setup.root, 'status', '--porcelain=v1'), git(setup.root, 'rev-parse', 'refs/remotes/origin/main')], before);
    });
    await check('real facade allocation creates two canonical worktrees without changing coordinator state', async () => {
      const setup = fixture();
      const firstAuthorization = await discover(setup);
      const first = await setup.provider.reserveIssue(setup.lease, setup.checkpoint().revision, firstAuthorization);
      const secondAuthorization = await discover(setup, 8);
      const second = await setup.provider.reserveIssue(setup.lease, setup.checkpoint().revision, secondAuthorization);
      git(setup.root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'coordinator is not configured base');
      assert.notEqual(git(setup.root, 'rev-parse', 'HEAD'), setup.baseOid);
      writeFileSync(join(setup.root, 'tracked.txt'), 'staged coordinator\n'); git(setup.root, 'add', 'tracked.txt');
      writeFileSync(join(setup.root, 'tracked.txt'), 'unstaged coordinator\n');
      const before = { branch: git(setup.root, 'symbolic-ref', 'HEAD'), head: git(setup.root, 'rev-parse', 'HEAD'),
        index: readFileSync(join(setup.repository.commonDir, 'index')).toString('hex'),
        tree: readFileSync(join(setup.root, 'tracked.txt'), 'utf8'), status: git(setup.root, 'status', '--porcelain=v1'),
        base: git(setup.root, 'rev-parse', 'refs/remotes/origin/main') };
      refuses(await setup.provider.allocateWorktree(null, first.unitId, setup.baseOid), 'LEASE_INVALID');
      refuses(await setup.provider.allocateWorktree(setup.lease, first.unitId, '0'.repeat(40)), 'BASE_CHANGED');
      for (const reservation of [first, second]) {
        const worktree = await setup.provider.allocateWorktree(setup.lease, reservation.unitId, setup.baseOid);
        assert.equal(worktree.unitId, reservation.unitId, JSON.stringify(worktree));
        assert.equal(worktree.root, join(setup.home, '.autoloop-worktrees', setup.repository.repositoryKey, setup.runId, `${reservation.unitId}-g1`));
        assert.equal(worktree.branch, `feat/gh-${reservation.issue}-unit-${reservation.unitId.replaceAll('-', '')}-g1`);
        assert.equal((await import('./claim-contract.mjs')).parseLoopBranchIssue(worktree.branch), reservation.issue);
        assert.equal(git(worktree.root, 'rev-parse', 'HEAD'), setup.baseOid);
        assert.equal(git(worktree.root, 'status', '--porcelain=v1', '--untracked-files=all'), '');
        assert.equal(worktree.gitDir, git(worktree.root, 'rev-parse', '--absolute-git-dir'));
        assert.equal(lstatSync(join(worktree.root, '.git')).isFile(), true);
        assert.deepEqual(await setup.provider.allocateWorktree(setup.lease, reservation.unitId, setup.baseOid), worktree);
        const checkpoint = setup.checkpoint(); const allocation = checkpoint.units.find((unit) => unit.unitId === reservation.unitId).allocation;
        assert.equal(scheduler.boundCreatorState(allocation.creator), 'empty');
        assert.deepEqual(allocation.creatorHistory, []);
        assert.equal(checkpoint.outbox[allocation.intent.operationId].phase, 'succeeded');
        assert.equal(checkpoint.outbox[allocation.intent.operationId].inputDigest, scheduler.schedulerDigest(allocation.intent));
        assert(checkpoint.outbox[allocation.intent.operationId].receipt.observationDigest);
        update(worktree.root);
        const reference = await setup.provider.scanRepository({ root: worktree.root });
        assert.equal(reference.gitDir, worktree.gitDir); assert.equal(reference.commonDir, setup.repository.commonDir);
        const blob = join(worktree.gitDir, 'autoloop', 'scheduler', 'snapshots', setup.runId, 'sha256', `${reference.contentDigest}.json`);
        assert.equal(JSON.parse(readFileSync(blob, 'utf8')).root, worktree.root);
        assert.equal(existsSync(join(setup.repository.commonDir, 'autoloop', 'scheduler', 'snapshots', setup.runId, 'sha256', `${reference.contentDigest}.json`)), false);
      }
      assert.deepEqual({ branch: git(setup.root, 'symbolic-ref', 'HEAD'), head: git(setup.root, 'rev-parse', 'HEAD'),
        index: readFileSync(join(setup.repository.commonDir, 'index')).toString('hex'),
        tree: readFileSync(join(setup.root, 'tracked.txt'), 'utf8'), status: git(setup.root, 'status', '--porcelain=v1'),
        base: git(setup.root, 'rev-parse', 'refs/remotes/origin/main') }, before);
      assert.equal(setup.checkpoint().queueEnabled, false); assert.deepEqual(setup.checkpoint().workers, []);
    });
    await check('foreign targets, existing refs and symlink ancestors are preserved without allocation', async () => {
      for (const collision of ['foreign', 'foreign-worktree', 'dirty-worktree', 'ref', 'symlink', 'target-symlink']) {
        const setup = fixture(); const authorization = await discover(setup);
        const reservation = await setup.provider.reserveIssue(setup.lease, setup.checkpoint().revision, authorization);
        const parent = join(setup.home, '.autoloop-worktrees');
        const root = join(parent, setup.repository.repositoryKey, setup.runId, `${reservation.unitId}-g1`);
        const branch = `feat/gh-7-unit-${reservation.unitId.replaceAll('-', '')}-g1`;
        if (collision === 'foreign') { mkdirSync(root, { recursive: true, mode: 0o700 }); writeFileSync(join(root, 'foreign.txt'), 'retain\n'); }
        if (['foreign-worktree', 'dirty-worktree', 'target-symlink'].includes(collision)) {
          mkdirSync(join(parent, setup.repository.repositoryKey, setup.runId), { recursive: true, mode: 0o700 });
          if (collision === 'target-symlink') { const foreign = join(setup.home, 'foreign'); mkdirSync(foreign); symlinkSync(foreign, root); }
          else {
            git(setup.root, 'worktree', 'add', '-q', '-b', branch, root, setup.baseOid);
            if (collision === 'dirty-worktree') writeFileSync(join(root, 'tracked.txt'), 'retain dirty\n');
          }
        }
        if (collision === 'ref') git(setup.root, 'branch', branch, setup.baseOid);
        if (collision === 'symlink') { const foreign = join(setup.home, 'foreign'); mkdirSync(foreign); symlinkSync(foreign, parent); }
        refuses(await setup.provider.allocateWorktree(setup.lease, reservation.unitId, setup.baseOid));
        assert.equal(setup.checkpoint().units[0].allocation, null); assert.deepEqual(setup.checkpoint().outbox, {});
        assert.equal(setup.checkpoint().reservations[0].state, 'planning');
        if (collision === 'foreign') assert.equal(readFileSync(join(root, 'foreign.txt'), 'utf8'), 'retain\n');
        if (collision === 'ref' || collision.endsWith('-worktree')) assert.equal(git(setup.root, 'rev-parse', `refs/heads/${branch}`), setup.baseOid);
        if (collision.endsWith('-worktree')) assert.equal(git(root, 'rev-parse', 'HEAD'), setup.baseOid);
        if (collision === 'dirty-worktree') assert.equal(readFileSync(join(root, 'tracked.txt'), 'utf8'), 'retain dirty\n');
        if (collision === 'symlink') assert(lstatSync(parent).isSymbolicLink());
        if (collision === 'target-symlink') assert(lstatSync(root).isSymbolicLink());
      }
    });
    await check('creator readiness is private and Git starts only after durable binding and owner checks', async () => {
      const setup = fixture(); const authorization = await discover(setup);
      const reservation = await setup.provider.reserveIssue(setup.lease, setup.checkpoint().revision, authorization);
      const marker = join(setup.home, 'ambient-creator-ran'); const preload = join(setup.home, 'ambient-creator.mjs');
      writeFileSync(preload, `import {writeFileSync} from 'node:fs';
try { if (JSON.parse(process.argv[1]).operationId) writeFileSync(${JSON.stringify(marker)}, 'unsafe'); } catch {}\n`);
      const originalNodeOptions = process.env.NODE_OPTIONS;
      process.env.NODE_OPTIONS = `${originalNodeOptions ?? ''} --import=${JSON.stringify(preload)}`;
      const stages = [];
      try {
        const allocator = createWorktreeAllocator({ lease: setup.lease, scanRepository: setup.provider.scanRepository,
          observe: (stage, { intent, creator }) => {
            stages.push(stage); const checkpoint = setup.checkpoint(); const allocation = checkpoint.units[0].allocation;
            assert.equal(existsSync(marker), false, 'Ambient Node preload must not run in the trusted creator.');
            if (stage !== 'created') assert.equal(existsSync(intent.root), false, 'Git must not run before durable binding and final checks.');
            if (stage === 'ready') { assert.equal(allocation.creator, null); assert.equal(checkpoint.outbox[intent.operationId].phase, 'prepared'); }
            if (stage === 'bound' || stage === 'created') assert.deepEqual(allocation.creator, creator);
            if (stage === 'created') assert.equal(scheduler.boundCreatorState(creator), 'empty');
            // Observation data has no private channel or shared mutable intent.
            intent.branch = 'not-the-durable-intent';
          } });
        const worktree = await allocator.allocateWorktree(setup.lease, reservation.unitId, setup.baseOid);
        assert.equal(worktree.unitId, reservation.unitId); assert.equal(git(worktree.root, 'rev-parse', 'HEAD'), setup.baseOid);
        assert.deepEqual(stages, ['prepared', 'ready', 'in-flight', 'bound', 'created']);
      } finally {
        if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = originalNodeOptions;
      }
    });
    await check('concurrent prepared allocation contenders create once and keep one current creator', async () => {
      const setup = fixture(); const authorization = await discover(setup);
      const reservation = await setup.provider.reserveIssue(setup.lease, setup.checkpoint().revision, authorization);
      const allocator = createWorktreeAllocator({ lease: setup.lease, scanRepository: setup.provider.scanRepository,
        observe: (stage) => { if (stage === 'prepared') throw new Error('Fixture interruption.'); } });
      await assert.rejects(allocator.allocateWorktree(setup.lease, reservation.unitId, setup.baseOid), /Fixture interruption/u);
      const outcomes = await Promise.all([1, 2].map(() => setup.provider.allocateWorktree(setup.lease, reservation.unitId, setup.baseOid)));
      assert.equal(outcomes.filter((value) => value.unitId === reservation.unitId).length, 1);
      assert.equal(outcomes.filter((value) => value.ok === false).length, 1);
      const allocation = setup.checkpoint().units[0].allocation;
      assert.equal(setup.checkpoint().outbox[allocation.intent.operationId].attempt, 1);
      assert.equal(setup.checkpoint().outbox[allocation.intent.operationId].phase, 'succeeded');
      assert.deepEqual(allocation.creatorHistory, []); assert.equal(scheduler.boundCreatorState(allocation.creator), 'empty');
      assert.equal(git(setup.root, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line === `worktree ${allocation.intent.root}`).length, 1);
    });
    await check('allocation interruption readback keeps intent and uses a new creator for a verified absent attempt', async () => {
      for (const interruption of ['prepared', 'ready', 'bound', 'created']) {
        const setup = fixture(); const authorization = await discover(setup);
        const reservation = await setup.provider.reserveIssue(setup.lease, setup.checkpoint().revision, authorization);
        const allocator = createWorktreeAllocator({ lease: setup.lease, scanRepository: setup.provider.scanRepository,
          observe: (stage) => { if (stage === interruption) throw new Error('Fixture interruption.'); } });
        await assert.rejects(allocator.allocateWorktree(setup.lease, reservation.unitId, setup.baseOid), /Fixture interruption/u);
        const interrupted = setup.checkpoint().units[0].allocation;
        const intent = structuredClone(interrupted.intent);
        assert.equal(setup.checkpoint().reservations[0].worktree, null);
        assert.equal(setup.checkpoint().reservations[0].slot, 1);
        if (interrupted.creator) assert.equal(scheduler.boundCreatorState(interrupted.creator), 'empty');
        const worktree = await setup.provider.allocateWorktree(setup.lease, reservation.unitId, setup.baseOid);
        assert.equal(worktree.unitId, reservation.unitId, JSON.stringify(worktree));
        const current = setup.checkpoint().units[0].allocation; const effect = setup.checkpoint().outbox[intent.operationId];
        assert.deepEqual(current.intent, intent);
        assert.equal(effect.phase, 'succeeded');
        if (interruption === 'bound') {
          assert.equal(effect.attempt, 2); assert.equal(current.creatorHistory.length, 1);
          assert.deepEqual(current.creatorHistory[0].creator, interrupted.creator);
          assert.equal(current.creatorHistory[0].attempt, 1);
          assert.notDeepEqual(current.creator, interrupted.creator, 'A retry must bind its new creator.');
          assert.equal(current.creatorHistory[0].receipt.externalId, intent.operationId);
        } else { assert.equal(effect.attempt, 1); assert.deepEqual(current.creatorHistory, []); }
      }
    });
    await check('unbound in-flight creator and partial, dirty or foreign allocation state retain their slots', async () => {
      for (const collision of ['unbound', 'dirty', 'symlink', 'partial-ref', 'foreign']) {
        const setup = fixture(); const authorization = await discover(setup); const secondAuthorization = await discover(setup, 8);
        const reservation = await setup.provider.reserveIssue(setup.lease, setup.checkpoint().revision, authorization);
        const interruption = collision === 'unbound' ? 'in-flight' : collision === 'dirty' || collision === 'symlink' ? 'created' : 'bound';
        const allocator = createWorktreeAllocator({ lease: setup.lease, scanRepository: setup.provider.scanRepository,
          observe: (stage) => { if (stage === interruption) throw new Error('Fixture interruption.'); } });
        await assert.rejects(allocator.allocateWorktree(setup.lease, reservation.unitId, setup.baseOid), /Fixture interruption/u);
        const allocation = setup.checkpoint().units[0].allocation; const { intent } = allocation;
        let preserved;
        if (collision === 'dirty') { preserved = join(intent.root, 'tracked.txt'); writeFileSync(preserved, 'retain dirty\n'); }
        if (collision === 'symlink') {
          // Keep the real worktree. A symlink in its admin backlink is not adopted.
          const gitDir = git(intent.root, 'rev-parse', '--absolute-git-dir');
          preserved = join(gitDir, 'commondir');
          const fs = await import('node:fs'); fs.renameSync(preserved, `${preserved}.fixture-original`);
          symlinkSync(`${preserved}.fixture-original`, preserved);
        }
        if (collision === 'partial-ref') git(setup.root, 'branch', intent.branch, setup.baseOid);
        if (collision === 'foreign') { mkdirSync(intent.root); preserved = join(intent.root, 'foreign.txt'); writeFileSync(preserved, 'retain foreign\n'); }
        const before = setup.checkpoint();
        refuses(await setup.provider.allocateWorktree(setup.lease, reservation.unitId, setup.baseOid));
        refuses(await setup.provider.reconcileWorktree(setup.lease, reservation.unitId));
        assert.deepEqual(setup.checkpoint(), before, 'Unknown readback must not erase or retry retained work.');
        assert.throws(() => scheduler.observeSelectionNoWork(setup.lease, reservation.unitId));
        if (collision === 'dirty') assert.equal(readFileSync(preserved, 'utf8'), 'retain dirty\n');
        if (collision === 'foreign') assert.equal(readFileSync(preserved, 'utf8'), 'retain foreign\n');
        if (collision === 'symlink') assert(lstatSync(preserved).isSymbolicLink());
        if (collision === 'partial-ref') assert.equal(git(setup.root, 'rev-parse', `refs/heads/${intent.branch}`), setup.baseOid);
        const second = await setup.provider.reserveIssue(setup.lease, before.revision, secondAuthorization);
        refuses(second, 'RECOVERY_REQUIRED');
        assert.equal(setup.checkpoint().reservations[0].slot, 1);
      }
    });
    await check('live and unverifiable creator groups cannot settle allocation or release its reservation', async () => {
      const setup = fixture(); const authorization = await discover(setup);
      const reservation = await setup.provider.reserveIssue(setup.lease, setup.checkpoint().revision, authorization);
      let observed = false;
      const allocator = createWorktreeAllocator({ lease: setup.lease, scanRepository: setup.provider.scanRepository,
        observe: async (stage, { creator }) => {
          if (stage !== 'bound') return;
          observed = true; const before = setup.checkpoint();
          assert.equal(scheduler.boundCreatorState(creator), 'alive');
          refuses(await setup.provider.reconcileWorktree(setup.lease, reservation.unitId), 'OWNER_UNVERIFIED');
          refuses(await setup.provider.allocateWorktree(setup.lease, reservation.unitId, setup.baseOid), 'OWNER_UNVERIFIED');
          assert.throws(() => scheduler.observeSelectionNoWork(setup.lease, reservation.unitId));
          assert.deepEqual(setup.checkpoint(), before);
          throw new Error('Fixture interruption.');
        } });
      await assert.rejects(allocator.allocateWorktree(setup.lease, reservation.unitId, setup.baseOid), /Fixture interruption/u);
      assert(observed);
      const exited = setup.checkpoint().units[0].allocation.creator;
      assert.equal(scheduler.boundCreatorState(exited), 'empty');
      assert.equal((await setup.provider.reconcileWorktree(setup.lease, reservation.unitId)).status, 'not-applied');
      assert.equal(setup.checkpoint().units[0].allocation.creator, null);
    });
    await check('a real surviving creator-group member is unknown, not verified absence or permission to retry', async () => {
      const setup = fixture(); const authorization = await discover(setup);
      const reservation = await setup.provider.reserveIssue(setup.lease, setup.checkpoint().revision, authorization);
      const allocator = createWorktreeAllocator({ lease: setup.lease, scanRepository: setup.provider.scanRepository,
        observe: (stage) => { if (stage === 'prepared') throw new Error('Fixture interruption.'); } });
      await assert.rejects(allocator.allocateWorktree(setup.lease, reservation.unitId, setup.baseOid), /Fixture interruption/u);
      const child = spawn(process.execPath, ['--input-type=module', '-e', `import { spawn } from 'node:child_process';
const member = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000);'], { stdio: 'ignore' });
process.send(member.pid); process.once('message', () => process.exit(0)); process.on('disconnect', () => process.exit(0));`],
        { cwd: setup.root, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      children.add(child); const exited = new Promise((done) => child.once('exit', done));
      let member;
      try {
        const pid = await new Promise((done, fail) => { child.once('message', done); child.once('error', fail); child.once('exit', () => fail(new Error('The group fixture ended before readiness.'))); });
        member = scheduler.readProcessIdentity(pid);
        const identity = scheduler.readProcessIdentity(child.pid); const creator = { process: identity, pgid: child.pid, groupLeader: identity };
        assert.equal(scheduler.processGroupOf(pid), creator.pgid);
        const allocation = setup.checkpoint().units[0].allocation;
        scheduler.markEffectInFlight(setup.lease, allocation.intent.operationId);
        scheduler.commitTransition(setup.lease, setup.checkpoint().revision, (checkpoint) => ({ ...checkpoint,
          units: checkpoint.units.map((unit) => ({ ...unit, allocation: { ...unit.allocation, creator } })) }));
        child.send('end leader'); await exited; children.delete(child);
        assert.equal(scheduler.boundCreatorState(creator), 'unknown');
        assert.equal(existsSync(allocation.intent.root), false);
        const before = setup.checkpoint();
        refuses(await setup.provider.reconcileWorktree(setup.lease, reservation.unitId), 'OWNER_UNVERIFIED');
        refuses(await setup.provider.allocateWorktree(setup.lease, reservation.unitId, setup.baseOid), 'OWNER_UNVERIFIED');
        assert.throws(() => scheduler.observeSelectionNoWork(setup.lease, reservation.unitId));
        assert.deepEqual(setup.checkpoint(), before); assert.equal(before.reservations[0].slot, 1);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        await exited; children.delete(child);
        if (member && scheduler.processIdentityState(member) === 'alive') process.kill(member.pid, 'SIGTERM');
      }
    });
    await check('queued control after creator binding stops Git and keeps immutable allocation history', async () => {
      const setup = fixture(); const authorization = await discover(setup);
      const reservation = await setup.provider.reserveIssue(setup.lease, setup.checkpoint().revision, authorization);
      const allocator = createWorktreeAllocator({ lease: setup.lease, scanRepository: setup.provider.scanRepository,
        observe: (stage) => {
          if (stage !== 'bound') return;
          scheduler.submitControl(setup.repository, { kind: 'terminal', sessionId: null, host: scheduler.readProcessIdentity(), invocationId: randomUUID() }, {
            schema: 'autoloop.control/2', requestId: randomUUID(), runId: setup.runId,
            target: { type: 'run', generation: setup.generation }, kind: 'pause', payload: {}, submittedAt: Date.now() });
        } });
      await assert.rejects(allocator.allocateWorktree(setup.lease, reservation.unitId, setup.baseOid), (error) => error.code === 'CONTROL_PENDING');
      const { intent, creator } = setup.checkpoint().units[0].allocation;
      assert.equal(existsSync(intent.root), false); assert.equal(scheduler.boundCreatorState(creator), 'empty');
      assert.equal((await setup.provider.reconcileWorktree(setup.lease, reservation.unitId)).status, 'not-applied');
      refuses(await setup.provider.allocateWorktree(setup.lease, reservation.unitId, setup.baseOid), 'CONTROL_PENDING');
      assert.equal(setup.checkpoint().units[0].allocation.creatorHistory.length, 1);
    });
    await check('actual owner loss before go never starts Git; owner loss after creation settles by exact readback', async () => {
      for (const interruption of ['in-flight', 'bound', 'created']) {
        const setup = fixture({ acquire: false });
        const script = `import * as scheduler from ${JSON.stringify(new URL('./scheduler-contract.mjs', import.meta.url).href)};
import { createSelectionProvider } from ${JSON.stringify(import.meta.url)};
import { createWorktreeAllocator } from ${JSON.stringify(new URL('./scheduler-worktree.mjs', import.meta.url).href)};
const { root, pins, baseOid, interruption } = JSON.parse(process.argv[1]);
const repository = scheduler.resolveRepository(root);
const acquired = scheduler.acquireScheduler(repository, pins, { kind: 'terminal', sessionId: null, process: scheduler.readProcessIdentity() });
scheduler.commitTransition(acquired.lease, 1, checkpoint => ({ ...checkpoint, state: 'running' }));
const provider = createSelectionProvider({ lease: acquired.lease });
const snapshot = await provider.scanRepository({ root });
const candidates = await provider.inventoryRecovery({ snapshot, checkpoint: scheduler.readCheckpoint(repository, acquired.runId) });
const authorization = candidates.find(item => item.kind === 'issue' && item.issue === 7).issueAuthorization;
const reservation = await provider.reserveIssue(acquired.lease, scheduler.readCheckpoint(repository, acquired.runId).revision, authorization);
const allocator = createWorktreeAllocator({ lease: acquired.lease, scanRepository: provider.scanRepository, observe: async (stage, facts) => {
  if (stage !== interruption) return;
  await new Promise((done, fail) => process.send({ facts, reservation, runId: acquired.runId }, error => error ? fail(error) : done()));
  process.kill(process.pid, 'SIGKILL');
} });
await allocator.allocateWorktree(acquired.lease, reservation.unitId, baseOid);`;
        const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify({ root: setup.root, pins: setup.pins, baseOid: setup.baseOid, interruption })],
          { cwd: setup.root, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        children.add(child); let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
        const exited = new Promise((done) => child.once('exit', (code, signal) => done({ code, signal })));
        const observed = await new Promise((done, fail) => {
          child.once('message', done); child.once('error', fail);
          child.once('exit', () => fail(new Error(`The owner ended before its interruption point. ${stderr}`)));
        });
        assert.equal((await exited).signal, 'SIGKILL'); children.delete(child);
        const { intent, creator } = observed.facts;
        if (interruption !== 'created') {
          const deadline = Date.now() + 10000;
          let ended = false;
          while (Date.now() < deadline) {
            const state = spawnSync('ps', ['-o', 'stat=', '-p', String(creator.process.pid)], { encoding: 'utf8', timeout: 5000 });
            if (state.status === 1 || /^Z/u.test(state.stdout.trim())) { ended = true; break; }
            await new Promise((done) => setTimeout(done, 10));
          }
          assert(ended, 'The creator must end on owner IPC loss without a go signal.');
          assert.equal(existsSync(intent.root), false);
          assert.equal(git(setup.root, 'for-each-ref', '--format=%(refname)', `refs/heads/${intent.branch}`), '');
        }
        const recovered = scheduler.acquireScheduler(setup.repository, setup.pins, { kind: 'terminal', sessionId: null, process: scheduler.readProcessIdentity() });
        owned.push({ repository: setup.repository, ...recovered });
        const provider = createSelectionProvider({ lease: recovered.lease });
        const checkpoint = () => scheduler.readCheckpoint(setup.repository, recovered.runId);
        assert.equal(checkpoint().state, 'recovering'); assert.equal(checkpoint().outbox[intent.operationId].phase, 'unknown');
        const creatorState = checkpoint().units[0].allocation.creator === null ? 'unbound' : scheduler.boundCreatorState(creator);
        const result = await provider.reconcileWorktree(recovered.lease, observed.reservation.unitId);
        if (interruption === 'created') {
          assert.equal(result.root, intent.root, JSON.stringify(result));
          assert.equal(checkpoint().outbox[intent.operationId].phase, 'succeeded');
          assert.deepEqual(checkpoint().units[0].allocation.intent, intent);
          assert.equal(checkpoint().reservations[0].worktree.baseOid, setup.baseOid);
        } else {
          if (creatorState !== 'empty') refuses(result, 'OWNER_UNVERIFIED');
          else assert.equal(result.status, 'not-applied');
          assert.equal(checkpoint().reservations[0].worktree, null); assert.equal(checkpoint().reservations[0].slot, 1);
          assert.throws(() => scheduler.observeSelectionNoWork(recovered.lease, observed.reservation.unitId));
        }
      }
    });
    await check('moved and renamed bound worktree returns refusals without retry or metadata adoption', async () => {
      const setup = fixture(); const authorization = await discover(setup);
      const reservation = await setup.provider.reserveIssue(setup.lease, setup.checkpoint().revision, authorization);
      const worktree = await setup.provider.allocateWorktree(setup.lease, reservation.unitId, setup.baseOid);
      assert.equal(worktree.unitId, reservation.unitId, JSON.stringify(worktree));
      const moved = join(setup.home, 'retained-moved-worktree'); const renamedBranch = `${worktree.branch}-retained`;
      git(setup.root, 'worktree', 'move', worktree.root, moved);
      git(moved, 'branch', '-m', renamedBranch);
      const before = setup.checkpoint();
      const outcomes = await Promise.allSettled([
        setup.provider.reconcileWorktree(setup.lease, reservation.unitId),
        setup.provider.allocateWorktree(setup.lease, reservation.unitId, setup.baseOid),
      ]);
      for (const outcome of outcomes) {
        assert.equal(outcome.status, 'fulfilled', outcome.reason?.stack);
        refuses(outcome.value, 'EVIDENCE_CHANGED');
      }
      assert.deepEqual(setup.checkpoint(), before);
      assert.equal(existsSync(worktree.root), false); assert(existsSync(worktree.gitDir));
      assert.equal(git(moved, 'symbolic-ref', '--short', 'HEAD'), renamedBranch);
      assert.equal(git(moved, 'rev-parse', 'HEAD'), setup.baseOid);
      assert.equal(git(moved, 'status', '--porcelain=v1'), '');
    });
    await check('replacement clean workspace cannot replace the saved worktree administrative identity', async () => {
      const setup = fixture(); const authorization = await discover(setup);
      const reservation = await setup.provider.reserveIssue(setup.lease, setup.checkpoint().revision, authorization);
      const worktree = await setup.provider.allocateWorktree(setup.lease, reservation.unitId, setup.baseOid);
      assert.equal(worktree.unitId, reservation.unitId, JSON.stringify(worktree));
      const moved = join(setup.home, 'retained-original-worktree'); const renamedBranch = `${worktree.branch}-retained`;
      git(setup.root, 'worktree', 'move', worktree.root, moved);
      git(moved, 'branch', '-m', renamedBranch);
      git(setup.root, 'worktree', 'add', '-q', '-b', worktree.branch, worktree.root, setup.baseOid);
      const replacement = scheduler.resolveRepositoryCheckout(worktree.root);
      assert.notEqual(replacement.gitDir, worktree.gitDir);
      assert.equal(git(worktree.root, 'rev-parse', 'HEAD'), setup.baseOid);
      assert.equal(git(worktree.root, 'status', '--porcelain=v1'), '');
      const before = setup.checkpoint();
      const outcomes = await Promise.allSettled([
        setup.provider.reconcileWorktree(setup.lease, reservation.unitId),
        setup.provider.allocateWorktree(setup.lease, reservation.unitId, setup.baseOid),
      ]);
      for (const outcome of outcomes) {
        assert.equal(outcome.status, 'fulfilled', outcome.reason?.stack);
        refuses(outcome.value, 'EVIDENCE_CHANGED');
      }
      assert.deepEqual(setup.checkpoint(), before);
      assert.equal(git(moved, 'rev-parse', '--absolute-git-dir'), worktree.gitDir);
      assert.equal(git(moved, 'symbolic-ref', '--short', 'HEAD'), renamedBranch);
      assert.equal(git(worktree.root, 'rev-parse', '--absolute-git-dir'), replacement.gitDir);
      assert.equal(git(worktree.root, 'symbolic-ref', '--short', 'HEAD'), worktree.branch);
      assert(existsSync(worktree.gitDir)); assert(existsSync(replacement.gitDir));
    });
    await check('no-work release requires actual clean base and exit proof and retains worktree and receipts', async () => {
      const setup = fixture(); const authorization = await discover(setup);
      const reservation = await setup.provider.reserveIssue(setup.lease, setup.checkpoint().revision, authorization);
      const worktree = await setup.provider.allocateWorktree(setup.lease, reservation.unitId, setup.baseOid);
      const before = structuredClone(setup.checkpoint().units[0].allocation);
      writeFileSync(join(worktree.root, 'tracked.txt'), 'do not release\n');
      assert.throws(() => scheduler.observeSelectionNoWork(setup.lease, reservation.unitId), (error) => error.code === 'EVIDENCE_CHANGED');
      assert.equal(setup.checkpoint().reservations[0].state, 'planning');
      writeFileSync(join(worktree.root, 'tracked.txt'), 'creation base\n');
      const disposition = scheduler.observeSelectionNoWork(setup.lease, reservation.unitId);
      const released = scheduler.commitTransition(setup.lease, setup.checkpoint().revision, (checkpoint) => ({ ...checkpoint,
        reservations: checkpoint.reservations.map((item) => ({ ...item, state: 'released', paths: [] })),
        units: checkpoint.units.map((item) => ({ ...item, disposition })) }));
      assert.equal(released.reservations[0].state, 'released');
      assert.deepEqual(released.units[0].allocation, before); assert.deepEqual(released.reservations[0].worktree, worktree);
      assert.equal(scheduler.hasRetainedSelection(released), false); assert(existsSync(worktree.root));
      assert.equal(released.outbox[before.intent.operationId].phase, 'succeeded');
    });
    await check('allocation rejects a moved configured base and uncertain success keeps its exact creation base', async () => {
      for (const interruption of [null, 'created']) {
        const setup = fixture(); const authorization = await discover(setup);
        const reservation = await setup.provider.reserveIssue(setup.lease, setup.checkpoint().revision, authorization);
        if (interruption) {
          const allocator = createWorktreeAllocator({ lease: setup.lease, scanRepository: setup.provider.scanRepository,
            observe: (stage) => { if (stage === interruption) throw new Error('Fixture interruption.'); } });
          await assert.rejects(allocator.allocateWorktree(setup.lease, reservation.unitId, setup.baseOid), /Fixture interruption/u);
        }
        const next = git(setup.root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit-tree',
          git(setup.root, 'rev-parse', 'HEAD^{tree}'), '-p', setup.baseOid, '-m', 'new configured base');
        git(setup.root, 'update-ref', 'refs/remotes/origin/main', next);
        if (interruption) {
          const worktree = await setup.provider.reconcileWorktree(setup.lease, reservation.unitId);
          assert.equal(worktree.baseOid, setup.baseOid, JSON.stringify(worktree)); assert.equal(git(worktree.root, 'rev-parse', 'HEAD'), setup.baseOid);
        } else {
          refuses(await setup.provider.allocateWorktree(setup.lease, reservation.unitId, setup.baseOid), 'BASE_CHANGED');
          refuses(await setup.provider.allocateWorktree(setup.lease, reservation.unitId, next), 'BASE_CHANGED');
          assert.equal(setup.checkpoint().units[0].allocation, null);
        }
        assert.equal(git(setup.root, 'rev-parse', 'refs/remotes/origin/main'), next);
        assert.equal(git(setup.root, 'rev-parse', 'HEAD'), setup.baseOid);
      }
    });
    await check('origin locator case differs from API spelling without changing source IDs or authorization', async () => {
      const setup = fixture(); update(setup.root, { apiCase: true });
      assert.equal(git(setup.root, 'config', '--get', 'remote.origin.url'), 'https://github.com/fixtures/selection.git');
      const authorization = await discover(setup);
      assert.deepEqual(authorization.subject.repository, { host: 'github.com', owner: 'Fixtures', name: 'Selection', nodeId: 'R_selection' });
      assert.equal(authorization.subject.issueNodeId, 'I_7'); assert.equal(authorization.subject.approval.eventId, 'E_7');
      const original = structuredClone(authorization);
      const reservation = await setup.provider.reserveIssue(setup.lease, setup.checkpoint().revision, authorization);
      assert.equal(reservation.schema, 'autoloop.reservation/1', JSON.stringify(reservation));
      assert.deepEqual(reservation.issueAuthorization, original);
      const checked = scheduler.readSelectionSnapshot(setup.lease, setup.checkpoint().units[0].checkedSnapshot, { current: false });
      assert.deepEqual(checked.repository, original.subject.repository); assert.equal(checked.sources.repository.nodeId, 'R_selection');
    });
    await check('artifact, body and caller evidence tampering cannot authorize selection', async () => {
      const setup = fixture(); const authorization = await discover(setup);
      const altered = structuredClone(authorization); altered.subject.issueBodyDigest = 'a'.repeat(64);
      altered.authorizationDigest = scheduler.schedulerDigest(altered.subject);
      refuses(await setup.provider.reserveIssue(setup.lease, setup.checkpoint().revision, altered), 'AUTHORIZATION_INVALID');
      const forged = structuredClone(authorization); forged.evidenceDigest = 'b'.repeat(64);
      refuses(await setup.provider.reserveIssue(setup.lease, setup.checkpoint().revision, forged), 'AUTHORIZATION_INVALID');
      const blob = join(authorization.snapshot.gitDir, 'autoloop', 'scheduler', 'snapshots', setup.runId, 'sha256', `${authorization.snapshot.contentDigest}.json`);
      const evidence = JSON.parse(readFileSync(blob, 'utf8'));
      evidence.sources.approvals[0].eventId = 'forged'; writeFileSync(blob, JSON.stringify(evidence));
      refuses(await setup.provider.reserveIssue(setup.lease, setup.checkpoint().revision, authorization));
      assert.deepEqual(setup.checkpoint().reservations, []);
    });
    await check('fresh reservation rechecks revoked, edited, incomplete, halted and dependency evidence', async () => {
      for (const facts of [{ permission: 'read' }, { edited: true }, { incomplete: true }, { halt: true }, { body: '## Blocked by\n- #40', dependencyOpen: true }, { missingIds: true }]) {
        const setup = fixture(); const authorization = await discover(setup); update(setup.root, facts);
        refuses(await setup.provider.reserveIssue(setup.lease, setup.checkpoint().revision, authorization));
        assert.deepEqual(setup.checkpoint().reservations, []);
      }
    });
    await check('missing source IDs stay visible without blocking a valid independent issue', async () => {
      const setup = fixture(); update(setup.root, { openNumbers: [8, 9], missingIdNumber: 9 });
      const reference = await setup.provider.scanRepository({ root: setup.root });
      const candidates = await setup.provider.inventoryRecovery({ snapshot: reference, checkpoint: setup.checkpoint() });
      const missing = candidates.find((item) => item.kind === 'refusal' && item.issue === 9);
      assert(missing, JSON.stringify(candidates)); assert.equal(missing.gating, false);
      refuses(missing.refusal, 'AUTHORIZATION_INVALID');
      assert.equal(Object.hasOwn(missing, 'unitId'), false); assert.equal(Object.hasOwn(missing, 'issueAuthorization'), false);
      refuses(await setup.provider.reserveIssue(setup.lease, setup.checkpoint().revision, missing.issueAuthorization), 'AUTHORIZATION_INVALID');
      const valid = candidates.find((item) => item.kind === 'issue' && item.issue === 8);
      const reservation = await setup.provider.reserveIssue(setup.lease, setup.checkpoint().revision, valid.issueAuthorization);
      assert.equal(reservation.issue, 8, JSON.stringify(reservation));
      assert.deepEqual(setup.checkpoint().reservations.map((item) => item.issue), [8]);
    });
    await check('original lease, expected revision and queued controls fence new reservations', async () => {
      const setup = fixture(); const authorization = await discover(setup);
      refuses(await setup.provider.reserveIssue(null, setup.checkpoint().revision, authorization), 'LEASE_INVALID');
      refuses(await setup.provider.reserveIssue(setup.lease, setup.checkpoint().revision - 1, authorization), 'REVISION_MISMATCH');
      scheduler.submitControl(setup.repository, { kind: 'terminal', sessionId: null, host: scheduler.readProcessIdentity(), invocationId: randomUUID() }, {
        schema: 'autoloop.control/2', requestId: randomUUID(), runId: setup.runId,
        target: { type: 'run', generation: setup.generation }, kind: 'pause', payload: {}, submittedAt: Date.now(),
      });
      refuses(await setup.provider.reserveIssue(setup.lease, setup.checkpoint().revision, authorization), 'CONTROL_PENDING');
      assert.deepEqual(setup.checkpoint().reservations, []);
    });
    await check('a control queued during the actual collector scan stops admission', async () => {
      const setup = fixture(); const authorization = await discover(setup);
      const barrier = { entered: join(setup.home, 'entered'), release: join(setup.home, 'release') }; update(setup.root, { barrier });
      const decision = setup.provider.reserveIssue(setup.lease, setup.checkpoint().revision, authorization);
      const deadline = Date.now() + 10000;
      try {
        while (!existsSync(barrier.entered) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
        assert(existsSync(barrier.entered), 'The actual collector must reach the barrier.');
        scheduler.submitControl(setup.repository, { kind: 'terminal', sessionId: null, host: scheduler.readProcessIdentity(), invocationId: randomUUID() }, {
          schema: 'autoloop.control/2', requestId: randomUUID(), runId: setup.runId,
          target: { type: 'run', generation: setup.generation }, kind: 'pause', payload: {}, submittedAt: Date.now(),
        });
      } finally { writeFileSync(barrier.release, 'release'); }
      refuses(await decision, 'CONTROL_PENDING'); assert.deepEqual(setup.checkpoint().reservations, []);
    });
    await check('contender processes propose one issue; one real owner commits once and uses exactly two slots', async () => {
      const setup = fixture(); const authorization = await discover(setup); const revision = setup.checkpoint().revision;
      const propose = () => new Promise((done, fail) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', 'process.send(JSON.parse(process.argv[1]),()=>process.disconnect());', JSON.stringify({ revision, authorization })], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        children.add(child); child.once('close', () => children.delete(child)); child.once('error', fail);
        child.once('message', done); child.once('close', (code) => { if (code) fail(new Error('The contender failed.')); });
      });
      const proposals = await Promise.all([propose(), propose()]);
      const outcomes = await Promise.all(proposals.map((proposal) => setup.provider.reserveIssue(setup.lease, proposal.revision, proposal.authorization)));
      assert.equal(outcomes.filter((value) => value.schema === 'autoloop.reservation/1').length, 1);
      refuses(outcomes.find((value) => value.ok === false), 'REVISION_MISMATCH');
      refuses(await setup.provider.reserveIssue(setup.lease, setup.checkpoint().revision, authorization), 'ISSUE_RESERVED');
      const second = await discover(setup, 8); const reserved = await setup.provider.reserveIssue(setup.lease, setup.checkpoint().revision, second);
      assert.equal(reserved.slot, 2, JSON.stringify(reserved));
      const third = await discover(setup, 9);
      refuses(await setup.provider.reserveIssue(setup.lease, setup.checkpoint().revision, third), 'SLOTS_FULL');
      assert.deepEqual(setup.checkpoint().reservations.map((item) => item.slot), [1, 2]);
    });
    await check('stopped retained selection is recovery, not a new run or a fabricated worker unit', async () => {
      const setup = fixture(); const authorization = await discover(setup);
      const reservation = await setup.provider.reserveIssue(setup.lease, setup.checkpoint().revision, authorization);
      assert.equal(reservation.schema, 'autoloop.reservation/1');
      scheduler.commitTransition(setup.lease, setup.checkpoint().revision, (checkpoint) => ({ ...checkpoint, state: 'stopped', desiredState: 'stopped' }));
      const snapshot = await setup.provider.scanRepository({ root: setup.root, pins: setup.pins });
      const inventory = await setup.provider.inventoryRecovery({ snapshot, checkpoint: setup.checkpoint() });
      assert.equal(inventory[0].kind, 'unit'); assert.equal(inventory[0].unitId, reservation.unitId);
      assert.equal(inventory.some((item) => item.kind === 'issue'), false);
      refuses(await setup.provider.reserveIssue(setup.lease, setup.checkpoint().revision, authorization), 'RUN_NOT_RUNNING');
      assert.equal(scheduler.hasRetainedSelection(setup.checkpoint()), true);
    });
    await check('gating recovery, closed-marker deferral and an unknown external result preserve selection order', async () => {
      const setup = fixture(); const authorization = await discover(setup, 8);
      const at = '2026-01-01T00:00:00Z';
      const marker = { v: 1, issue: 7, branch: 'feat/gh-7-fixture', intentSource: 'invocation', selector: 'native',
        issueBodyHash: createHash('sha256').update('Fixture body.\n').digest('hex'), mergePolicy: 'manual',
        phase: 'intent-recorded', planHash: scheduler.schedulerDigest({ fixture: 'plan' }), plannedBaseOid: setup.baseOid,
        runIntentHash: scheduler.schedulerDigest({ fixture: 'intent' }) };
      const comment = { id: 'IC_marker', author: { login: 'maintainer' }, authorAssociation: 'MEMBER', viewerDidAuthor: true,
        body: serializeLifecycleMarker(marker), createdAt: at, lastEditedAt: null, updatedAt: at, url: 'https://github.com/fixtures/selection/issues/7#issuecomment-1' };
      update(setup.root, { comments: { 7: [comment] } });
      const reference = await setup.provider.scanRepository({ root: setup.root });
      const candidates = await setup.provider.inventoryRecovery({ snapshot: reference, checkpoint: setup.checkpoint() });
      assert.equal(candidates[0].kind, 'lifecycle'); assert.equal(candidates[0].gating, true);
      assert.equal(candidates.some((item) => item.kind === 'issue'), false);
      refuses(await setup.provider.reserveIssue(setup.lease, setup.checkpoint().revision, authorization), 'RECOVERY_REQUIRED');
      const page = (nodes) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
      const pr = { id: 'PR_10', number: 10, title: 'Fixture PR', body: 'Closes #7', isDraft: true, headRefName: 'feat/gh-7-fixture',
        headRefOid: setup.baseOid, baseRefName: 'main', mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', updatedAt: at, author: { login: 'maintainer' },
        headRepository: { nameWithOwner: 'fixtures/selection' }, files: page([{ path: 'src/a.mjs' }]), commits: { nodes: [] } };
      update(setup.root, { prs: [pr] });
      const draftRef = await setup.provider.scanRepository({ root: setup.root });
      assert.equal(draftRef.schema, 'autoloop.snapshot-reference/1', JSON.stringify(draftRef));
      const draftCandidates = await setup.provider.inventoryRecovery({ snapshot: draftRef, checkpoint: setup.checkpoint() });
      assert(draftCandidates.some((item) => item.kind === 'orphan' && item.gating));
      assert.equal(draftCandidates.some((item) => item.kind === 'issue'), false);
      refuses(await setup.provider.reserveIssue(setup.lease, setup.checkpoint().revision, authorization), 'RECOVERY_REQUIRED');
      update(setup.root, { prs: [{ ...pr, isDraft: false }], comments: { 7: [{ ...comment,
        body: serializeLifecycleMarker({ ...marker, phase: 'ready-head', claimCommit: setup.baseOid, headOid: setup.baseOid, pr: 10 }) }] } });
      const deliveredRef = await setup.provider.scanRepository({ root: setup.root });
      const deliveredCandidates = await setup.provider.inventoryRecovery({ snapshot: deliveredRef, checkpoint: setup.checkpoint() });
      const delivered = deliveredCandidates.find((item) => item.kind === 'delivered');
      assert.equal(delivered.number, 10); assert.equal(delivered.gating, false); assert.deepEqual(delivered.paths, ['src/a.mjs']);
      assert(deliveredCandidates.some((item) => item.kind === 'issue' && item.issue === 8));
      assert.equal(deliveredCandidates.some((item) => item.kind === 'issue' && item.issue === 7), false);
      update(setup.root, { openNumbers: [8, 9], mergedPrs: [{ ...pr, isDraft: false, mergedAt: at }], comments: { 7: [comment] } });
      const deferredRef = await setup.provider.scanRepository({ root: setup.root });
      const deferredCandidates = await setup.provider.inventoryRecovery({ snapshot: deferredRef, checkpoint: setup.checkpoint() });
      assert.equal(deferredCandidates[0].kind, 'lifecycle'); assert.equal(deferredCandidates[0].gating, false);
      assert(deferredCandidates.some((item) => item.kind === 'issue' && item.issue === 8));
      const independent = await setup.provider.reserveIssue(setup.lease, setup.checkpoint().revision, authorization);
      assert.equal(independent.schema, 'autoloop.reservation/1', JSON.stringify(independent));
      const another = await discover(setup, 9);
      const operationId = randomUUID();
      scheduler.prepareEffect(setup.lease, setup.checkpoint().revision, { operationId, requestId: null, runId: setup.runId,
        unitId: null, unitGeneration: null, kind: 'external.fixture', target: { type: 'external', id: operationId },
        inputDigest: scheduler.schedulerDigest({ fixture: 'unknown outcome' }), expectedHead: null, phase: 'prepared', attempt: 1, receipt: null, error: null });
      scheduler.markEffectInFlight(setup.lease, operationId);
      const external = spawnSync(process.execPath, ['-e', 'process.kill(process.pid,"SIGKILL");'], { timeout: 5000 });
      assert.equal(external.signal, 'SIGKILL');
      scheduler.settleEffect(setup.lease, operationId, { attempt: 1, status: 'unknown', code: 'FIXTURE_OUTCOME_UNKNOWN', receipt: null });
      const unknownRef = await setup.provider.scanRepository({ root: setup.root });
      const unknownCandidates = await setup.provider.inventoryRecovery({ snapshot: unknownRef, checkpoint: setup.checkpoint() });
      assert(unknownCandidates.some((item) => item.kind === 'effect' && item.gating));
      assert.equal(unknownCandidates.some((item) => item.kind === 'issue'), false);
      refuses(await setup.provider.reserveIssue(setup.lease, setup.checkpoint().revision, another), 'RECOVERY_REQUIRED');
    });
    await check('legacy worker-only records stay retained and precede fresh selection', async () => {
      const setup = fixture(); const authorization = await discover(setup);
      const child = spawn(process.execPath, ['--input-type=module', '-e', 'process.send("ready");process.on("disconnect",()=>process.exit(0));setInterval(()=>{},1000);'],
        { cwd: setup.root, detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      children.add(child); const closed = new Promise((done) => child.once('close', done));
      child.once('close', () => children.delete(child));
      try {
        await new Promise((done, fail) => { child.once('message', done); child.once('error', fail); child.once('close', () => fail(new Error('The worker ended before readiness.'))); });
        const attemptId = randomUUID();
        const identity = scheduler.readProcessIdentity(child.pid);
        const worker = { schema: 'autoloop.worker-binding/1', runId: setup.runId, generation: setup.generation,
          unitId: randomUUID(), unitGeneration: 1, attemptId, sessionId: randomUUID(), worktreeGitDir: git(setup.root, 'rev-parse', '--absolute-git-dir'),
          process: identity, pgid: child.pid, groupLeader: identity, role: 'implement', posture: 'writer', actualModel: 'fixture-worker',
          liveFile: join(setup.repository.commonDir, 'autoloop', 'scheduler', 'runs', setup.runId, 'streams', `${attemptId}.jsonl`), cancelledByOperator: false };
        scheduler.registerWorker(setup.lease, setup.checkpoint().revision, worker, { guardDirectory: join(scratch, 'workers') });
        const reference = await setup.provider.scanRepository({ root: setup.root });
        const candidates = await setup.provider.inventoryRecovery({ snapshot: reference, checkpoint: setup.checkpoint() });
        assert.equal(candidates[0].kind, 'worker'); assert.equal(candidates[0].gating, true);
        assert.deepEqual(setup.checkpoint().units, []); assert.deepEqual(setup.checkpoint().reservations, []);
        refuses(await setup.provider.reserveIssue(setup.lease, setup.checkpoint().revision, authorization), 'RECOVERY_REQUIRED');
        assert.equal(setup.checkpoint().workers.length, 1);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        await closed;
      }
    });
    await check('changed configured base and coordinator config invalidate current evidence', async () => {
      const setup = fixture(); const authorization = await discover(setup);
      const tree = git(setup.root, 'rev-parse', 'HEAD^{tree}');
      const nextBase = git(setup.root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit-tree', tree, '-p', setup.baseOid, '-m', 'next base');
      git(setup.root, 'update-ref', 'refs/remotes/origin/main', nextBase);
      assert.throws(() => scheduler.readSelectionSnapshot(setup.lease, authorization.snapshot), (error) => error.code === 'EVIDENCE_CHANGED');
      assert.equal(scheduler.readSelectionSnapshot(setup.lease, authorization.snapshot, { current: false }).baseOid, setup.baseOid);
      assert.equal(git(setup.root, 'rev-parse', 'HEAD'), setup.baseOid);
      const reference = await setup.provider.scanRepository({ root: setup.root });
      assert.equal(reference.baseOid, nextBase); assert.equal(reference.headOid, setup.baseOid);
      writeFileSync(join(setup.root, '.autoloop', 'config.json'), JSON.stringify({ ...setup.pins.config, baseBranch: 'other' }));
      refuses(await setup.provider.scanRepository({ root: setup.root }), 'PINS_CHANGED');
      refuses(await setup.provider.reserveIssue(setup.lease, setup.checkpoint().revision, authorization), 'PINS_CHANGED');
      assert.deepEqual(setup.checkpoint().reservations, []);
    });
    await check('linked checkout evidence uses its actual admin directory and pinned coordinator config', async () => {
      const setup = fixture(); const linked = join(setup.home, 'linked'); git(setup.root, 'worktree', 'add', '-q', '--detach', linked, setup.baseOid); update(linked);
      mkdirSync(join(linked, '.autoloop')); writeFileSync(join(linked, '.autoloop', 'config.json'), '{"editable":"not coordinator authority"}');
      const reference = await setup.provider.scanRepository({ root: linked, pins: setup.pins });
      assert.equal(reference.schema, 'autoloop.snapshot-reference/1', JSON.stringify(reference));
      assert.equal(reference.root, linked); assert.equal(reference.gitDir, git(linked, 'rev-parse', '--absolute-git-dir'));
      assert.equal(reference.commonDir, setup.repository.commonDir); assert.equal(reference.baseOid, setup.baseOid);
      const absent = fixture({ base: false });
      refuses(await absent.provider.scanRepository({ root: absent.root, pins: absent.pins }));
    });
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = new Promise((done) => child.once('close', done));
        child.kill('SIGTERM'); await closed;
      }
    }
    for (const item of owned) {
      try {
        const checkpoint = scheduler.readCheckpoint(item.repository, item.runId);
        if (!['stopped', 'failed'].includes(checkpoint.state)) scheduler.commitTransition(item.lease, checkpoint.revision, (value) => ({ ...value, state: 'stopped', desiredState: 'stopped' }));
        scheduler.releaseScheduler(item.lease);
      } catch (error) { console.error(`Fixture retained: ${error.message}`); }
    }
    process.env.PATH = originalPath;
    if (originalFixture === undefined) delete process.env.SELECTION_FIXTURE; else process.env.SELECTION_FIXTURE = originalFixture;
    account.restore();
    // Retain fixtures when recursive cleanup is not approved by the host.
    console.log(`Fixtures retained at ${scratch}`);
  }
  console.log(results.every(([, ok]) => ok) ? `self-test OK (${results.length} cases)` : 'self-test FAILED');
  return results.every(([, ok]) => ok);
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) {
  if (process.argv.length === 3 && process.argv[2] === '--self-test') process.exit(await selfTest() ? 0 : 1);
  console.error('usage: scheduler-selection.mjs --self-test');
  process.exit(2);
}
