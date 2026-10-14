// Import-only admission service. A plan proposes paths; only the lease owner commits them.
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as scheduler from './scheduler-contract.mjs';
import { boundedGit } from './git-budget.mjs';
import { BoundaryPathError, canonicalBoundary, inLane, intersectBoundaries, widenLane } from './lane-contract.mjs';
import { issueAuthorizationEvidence, requestedPlanGenerationFloor, validateIssueAuthorizationEvidence, validatePlanArtifact, validateSnapshotReference } from './scheduler-selection-schema.mjs';
import { readPlanningWorktreeContext } from './scheduler-planning-context.mjs';
import { deliveredPullRequests, haltIssueNumbers, markerSchedule } from './snapshot-contract.mjs';
import { protectedPaths } from './run-markers.mjs';

const equal = (a, b) => scheduler.schedulerDigest(a) === scheduler.schedulerDigest(b);
function requireCondition(ok, code, message) {
  if (!ok) throw new scheduler.SchedulerError(code, message);
}
function exact(value, names) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const keys = Reflect.ownKeys(value);
  return keys.every((key) => typeof key === 'string') && keys.sort().join('\0') === [...names].sort().join('\0')
    && keys.every((key) => { const field = Object.getOwnPropertyDescriptor(value, key); return field.enumerable && Object.hasOwn(field, 'value'); });
}
function git(root, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });
  const result = boundedGit(['--no-lazy-fetch', '--no-replace-objects', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', root, ...args], { env, maxBuffer: 1024 * 1024 });
  requireCondition(result.status === 0 && !result.error, 'WORKTREE_UNVERIFIED', 'The bound workspace Git facts cannot be verified.');
  return result.stdout.trim();
}
function regularText(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    requireCondition(fstatSync(fd).isFile(), 'WORKTREE_UNVERIFIED', 'A workspace record is not a valid regular file.');
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}
function selectionUnit(checkpoint, unitId) {
  const unit = checkpoint.units.find((row) => row.unitId === unitId);
  const reservation = checkpoint.reservations.find((row) => row.unitId === unitId);
  requireCondition(unit && reservation && reservation.state !== 'released', 'TARGET_MISMATCH', 'The active selection unit does not exist.');
  return { unit, reservation };
}
function requireOpen(context) {
  const { checkpoint, repository } = context;
  requireCondition(checkpoint.state === 'running' && checkpoint.desiredState === 'running', 'RUN_NOT_RUNNING', 'The run does not accept path admission.');
  requireCondition(scheduler.listControlRequests(repository, checkpoint.runId).length === 0
    && !Object.values(checkpoint.requests).some((row) => ['pending', 'processing', 'unknown'].includes(row.status)),
  'CONTROL_PENDING', 'An operator request must be processed before path admission.');
  requireCondition(!scheduler.hasUnresolvedEffects(checkpoint) && !scheduler.planningRelationshipRecovery(checkpoint).pending
    && checkpoint.workers.every((worker) => scheduler.boundGroupState(worker) === 'empty')
    && !checkpoint.reservations.some((row) => row.state === 'recovering'),
  'RECOVERY_REQUIRED', 'Retained workers and effects must be reconciled before path admission.');
}
function boundWorktree(context, unit, reservation) {
  const binding = reservation.worktree; const allocation = unit.allocation;
  requireCondition(binding && allocation && context.checkpoint.outbox[allocation.intent.operationId]?.phase === 'succeeded',
    'WORKTREE_REQUIRED', 'Path admission requires a settled bound workspace.');
  requireCondition(allocation.creator && scheduler.boundCreatorState(allocation.creator) === 'empty',
    'OWNER_UNVERIFIED', 'The workspace creator must have a verified exit.');
  try {
    const actual = scheduler.resolveRepositoryCheckout(binding.root);
    requireCondition(['root', 'gitDir', 'commonDir', 'repositoryKey'].every((key) => binding[key] === actual[key])
      && binding.commonDir === context.repository.commonDir && realpathSync(binding.root) === binding.root
      && !lstatSync(binding.root).isSymbolicLink() && realpathSync(binding.gitDir) === binding.gitDir
      && regularText(join(binding.root, '.git')) === `gitdir: ${binding.gitDir}\n`
      && regularText(join(binding.gitDir, 'gitdir')) === `${join(binding.root, '.git')}\n`
      && realpathSync(resolve(binding.gitDir, regularText(join(binding.gitDir, 'commondir')).trim())) === binding.commonDir
      && git(binding.root, ['symbolic-ref', '--short', 'HEAD']) === binding.branch,
    'EVIDENCE_CHANGED', 'The bound workspace identity or branch changed.');
    const registrations = git(context.pins.coordinatorRoot, ['worktree', 'list', '--porcelain', '-z']).split('\0\0');
    requireCondition(registrations.filter((row) => row.split('\0').includes(`worktree ${binding.root}`)
      && row.split('\0').includes(`branch refs/heads/${binding.branch}`)).length === 1,
    'EVIDENCE_CHANGED', 'The bound workspace registration changed.');
  } catch (error) {
    if (error instanceof scheduler.SchedulerError) throw error;
    throw new scheduler.SchedulerError('WORKTREE_UNVERIFIED', 'The bound workspace cannot be verified.');
  }
  return binding;
}
function requireRetainedScope(worktree, retained, proposed, baseOid) {
  let facts;
  try { facts = readPlanningWorktreeContext(worktree.root, retained, proposed, baseOid); }
  catch (error) {
    throw new scheduler.SchedulerError(error.code ?? 'EVIDENCE_CHANGED', 'The retained worktree edit scope cannot be verified.');
  }
  // Older records can have plan metadata without a previously admitted scope.
  requireCondition(retained.length > 0 || facts.initialClean === true, 'EVIDENCE_CHANGED', 'An initial plan requires a clean allocated workspace.');
}
function canonical(root, entries) {
  try { return canonicalBoundary(root, entries); }
  catch (error) {
    if (!(error instanceof BoundaryPathError)) throw error;
    throw new scheduler.SchedulerError(error.code, error.message);
  }
}
function candidatePlan(proposed, unit, reservation) {
  requireCondition(exact(proposed, ['unitId', 'unitGeneration', 'planGeneration', 'planDigest', 'artifact'])
    && validatePlanArtifact(proposed.artifact).length === 0, 'PLAN_INVALID', 'The plan candidate must contain the exact versioned artifact.');
  const artifact = proposed.artifact;
  requireCondition(proposed.unitId === unit.unitId && artifact.unitId === unit.unitId
    && proposed.unitGeneration === unit.unitGeneration && artifact.unitGeneration === unit.unitGeneration
    && artifact.repositoryKey === reservation.repositoryKey && artifact.issue === reservation.issue
    && artifact.issueBodyDigest === reservation.issueAuthorization.subject.issueBodyDigest
    && artifact.authorizationDigest === reservation.issueAuthorization.authorizationDigest
    && proposed.planGeneration === artifact.planGeneration && scheduler.schedulerDigest(artifact) === proposed.planDigest,
  'PLAN_INVALID', 'The plan content, digest or reserved identity does not match.');
  requireCondition(proposed.planGeneration > requestedPlanGenerationFloor(unit) && proposed.planDigest !== unit.plan?.planDigest,
    'PLAN_STALE', 'Admission requires a plan generation above the retained request floor and a new digest.');
  return structuredClone(proposed);
}
function policyEntries(root, paths) {
  const entries = new Set(paths); const pending = paths.filter((path) => path.endsWith('/'));
  while (pending.length) {
    const path = pending.pop(); let stat;
    try { stat = lstatSync(join(root, path)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    requireCondition(stat.isDirectory() && !stat.isSymbolicLink(), 'BOUNDARY_PATH_UNSAFE', 'A policy directory changed during observation.');
    for (const child of readdirSync(join(root, path), { withFileTypes: true })) {
      requireCondition(child.isFile() || child.isDirectory(), 'BOUNDARY_PATH_UNSAFE', 'A policy directory contains an unsafe object.');
      const entry = `${path}${child.name}${child.isDirectory() ? '/' : ''}`;
      if (!entries.has(entry)) { entries.add(entry); if (child.isDirectory()) pending.push(entry); }
    }
  }
  return [...entries].sort();
}
function policyFor(context, worktree, paths) {
  const entries = policyEntries(worktree.root, paths); const authorize = [];
  for (const entry of entries) {
    const widened = widenLane([], [entry], context.pins.config.protectedPaths ?? []);
    requireCondition(widened.ok, widened.code ?? 'POLICY_DENIED', 'The boundary includes a forbidden secret or guardrail path.');
    authorize.push(...widened.authorize);
  }
  const protectedSet = protectedPaths({ projectRoot: worktree.root, cwd: worktree.root, runOpen: true });
  const forbidden = [...protectedSet.state, ...protectedSet.code,
    join(context.pins.pluginRoot, 'tools'), join(context.pins.pluginRoot, 'hooks')];
  requireCondition(paths.every((entry) => {
    const target = join(worktree.root, entry.replace(/\/$/u, '')).toLowerCase();
    return forbidden.every((spelling) => {
      const path = spelling.toLowerCase();
      return target !== path && !target.startsWith(`${path}/`) && !(entry.endsWith('/') && path.startsWith(`${target}/`));
    });
  }), 'POLICY_DENIED', 'The boundary includes actual hook, guard code or execution state.');
  return authorize;
}
function conflictsFor(checkpoint, evidence, reservation, proposed) {
  const conflicts = []; const conditions = [];
  for (const other of checkpoint.reservations) {
    if (other.unitId === reservation.unitId || other.state === 'released' || other.paths.length === 0) continue;
    requireCondition(other.worktree, 'WORKTREE_UNVERIFIED', 'Retained exclusion paths need their bound workspace.');
    const retained = canonical(other.worktree.root, other.paths);
    const paths = intersectBoundaries(proposed.boundary, retained.boundary,
      { caseSensitive: proposed.pathRules.caseSensitive && retained.pathRules.caseSensitive });
    if (paths.length) { conflicts.push({ type: 'unit', id: other.unitId, paths }); conditions.push({ on: 'unit-release', unitId: other.unitId, unitGeneration: other.unitGeneration }); }
  }
  for (const delivered of deliveredPullRequests(evidence.snapshot)) {
    const retained = canonical(evidence.root, delivered.files);
    const paths = intersectBoundaries(proposed.boundary, retained.boundary,
      { caseSensitive: proposed.pathRules.caseSensitive && retained.pathRules.caseSensitive });
    if (paths.length) { conflicts.push({ type: 'pr', id: delivered.pr, paths }); conditions.push({ on: 'pr', number: delivered.pr }); }
  }
  return { conflicts, conditions };
}

function waitConditionMet(checkpoint, evidence, condition) {
  if (condition.on === 'unit-release') {
    const reservation = checkpoint.reservations.find((row) => row.unitId === condition.unitId && row.unitGeneration === condition.unitGeneration);
    const released = checkpoint.units.find((row) => row.unitId === condition.unitId && row.unitGeneration === condition.unitGeneration);
    return reservation?.state === 'released' && Boolean(released?.disposition)
      && reservation.paths.length === 0 && checkpoint.workers.filter((worker) => worker.unitId === condition.unitId)
        .every((worker) => scheduler.boundGroupState(worker) === 'empty')
      && (!released.allocation || released.allocation.creator !== null && scheduler.boundCreatorState(released.allocation.creator) === 'empty')
      && !Object.values(checkpoint.outbox).some((effect) => effect.unitId === condition.unitId && ['prepared', 'in-flight', 'unknown'].includes(effect.phase));
  }
  const section = condition.on === 'pr' ? evidence.sources.waitPullRequests : evidence.sources.waitIssues;
  const fact = section.items.find((row) => row.number === condition.number);
  requireCondition(section.complete && fact?.nodeId, 'EVIDENCE_INCOMPLETE', 'Wait reconciliation requires direct complete issue and PR facts.');
  return ['CLOSED', 'MERGED'].includes(fact.state);
}

export function createBoundaryService({ lease, scanRepository }) {
  const checkRelationship = (expectedRevision, relationshipId, candidate) => scheduler.readFailingTaskRelationship(lease, expectedRevision,
    relationshipId, { unitId: candidate.unitId, unitGeneration: candidate.unitGeneration, proposedPlanArtifact: candidate.artifact });
  const decideBoundary = async (originalLease, expectedRevision, proposed, relationshipId = null) => {
    requireCondition(originalLease === lease, 'LEASE_INVALID', 'The mutation requires the original owner lease.');
    const context = scheduler.readSchedulerContext(lease);
    requireCondition(context.checkpoint.revision === expectedRevision, 'REVISION_MISMATCH', 'The checkpoint revision changed.');
    requireOpen(context);
    const { unit, reservation } = selectionUnit(context.checkpoint, proposed?.unitId);
    const widening = relationshipId !== null;
    requireCondition(widening ? reservation.state === 'admitted' || reservation.state === 'planning' && unit.replanRequired
      : reservation.state === 'planning', 'PLAN_STALE', 'The unit must be admitted or in the required read-only planning state.');
    const worktree = boundWorktree(context, unit, reservation);
    const candidate = candidatePlan(proposed, unit, reservation);
    if (widening) checkRelationship(expectedRevision, relationshipId, candidate);
    const reference = await scanRepository({ root: worktree.root, pins: context.pins });
    const current = scheduler.readSchedulerContext(lease);
    requireCondition(current.checkpoint.revision === expectedRevision, 'REVISION_MISMATCH', 'The checkpoint changed during path admission.');
    requireOpen(current);
    const evidence = scheduler.readSelectionSnapshot(lease, reference);
    requireCondition(candidate.artifact.baseOid === evidence.baseOid
      && git(worktree.root, ['merge-base', evidence.baseOid, evidence.headOid]) === evidence.baseOid,
    'BASE_CHANGED', 'The plan and actual workspace ancestry must include the current configured base.');
    const original = scheduler.readSelectionSnapshot(lease, reservation.issueAuthorization.snapshot, { current: false });
    requireCondition(validateIssueAuthorizationEvidence(reservation.issueAuthorization, original).length === 0
      && issueAuthorizationEvidence({ ...reservation.issueAuthorization, snapshot: reference }, evidence) !== null,
    'AUTHORIZATION_REVOKED', 'The approval, role or issue body no longer authorizes this plan.');
    requireCondition(haltIssueNumbers(evidence.snapshot).length === 0, 'RUN_HALTED', 'A halt issue prevents path admission.');
    const deliveredIssues = new Set(deliveredPullRequests(evidence.snapshot).map((row) => row.issue));
    requireCondition(markerSchedule(evidence.snapshot).gating.every((issue) => deliveredIssues.has(issue))
      && !evidence.snapshot.sections.openPrs.items.some((pr) => pr.orphanCandidate),
    'RECOVERY_REQUIRED', 'Repository recovery must precede path admission.');
    const boundary = canonical(worktree.root, candidate.artifact.boundary);
    requireCondition(equal(candidate.artifact.boundary, boundary.boundary), 'PLAN_INVALID', 'The hashed artifact must contain its exact canonical boundary.');
    requireCondition(reservation.paths.every((path) => boundary.boundary.includes(path)), 'WIDEN_SHRINK', 'A new plan must retain every prior exclusion path.');
    requireCondition(widening || reservation.paths.length === 0 || boundary.boundary.every((path) => inLane(path, reservation.paths)),
      'WIDEN_REASON_REQUIRED', 'Expansion beyond retained paths requires the owner-observed widening route.');
    const obligations = policyFor(current, worktree, boundary.boundary);
    if (!widening) requireRetainedScope(worktree, reservation.paths, boundary.boundary, evidence.baseOid);
    const plan = { planGeneration: candidate.planGeneration, planDigest: candidate.planDigest, baseOid: candidate.artifact.baseOid, boundary: boundary.boundary };
    // Module 2 validates the complete immutable input value. Only core writes
    // its durable plan metadata, exclusion paths and admission together. Full
    // artifact storage and posted-plan proof belong to the module-3 provider.
    const committed = scheduler.commitTransition(lease, expectedRevision, (checkpoint) => {
      requireOpen({ ...current, checkpoint });
      const checked = scheduler.readSelectionSnapshot(lease, reference);
      boundWorktree({ ...current, checkpoint }, unit, reservation);
      const observed = canonical(worktree.root, candidate.artifact.boundary);
      requireCondition(equal(observed.boundary, boundary.boundary), 'EVIDENCE_CHANGED', 'The canonical boundary changed.');
      if (widening) checkRelationship(expectedRevision, relationshipId, candidate);
      else requireRetainedScope(worktree, reservation.paths, observed.boundary, checked.baseOid);
      const { conflicts, conditions } = conflictsFor(checkpoint, checked, reservation, observed);
      const wait = conflicts.length ? { schema: 'autoloop.selection-wait/1', code: 'BOUNDARY_CONFLICT', unitId: unit.unitId,
        conflicts, condition: { all: conditions }, requestedPlan: plan, snapshot: reference, createdRevision: checkpoint.revision + 1 } : null;
      const admission = wait ? null : { schema: 'autoloop.admission/1', runId: checkpoint.runId, unitId: unit.unitId,
        unitGeneration: unit.unitGeneration, ...plan, reservationRevision: checkpoint.revision + 1 };
      const authorize = [...unit.policy.authorize];
      const freshObligations = policyFor(current, worktree, observed.boundary);
      for (const obligation of [...obligations, ...freshObligations]) {
        if (!authorize.some((item) => equal(item, obligation))) authorize.push(obligation);
      }
      return { ...checkpoint,
        reservations: checkpoint.reservations.map((row) => row.unitId === unit.unitId ? { ...row, state: wait ? 'waiting' : 'admitted', paths: wait ? row.paths : plan.boundary } : row),
        units: checkpoint.units.map((row) => row.unitId === unit.unitId ? { ...row, plan: wait ? row.plan : plan,
          lastRequestedPlanGeneration: candidate.planGeneration, admission, wait, checkedSnapshot: reference, replanRequired: false, policy: { authorize } } : row) };
    });
    const updated = committed.units.find((row) => row.unitId === unit.unitId);
    return updated.wait ?? updated.admission;
  };
  const admitBoundary = (originalLease, expectedRevision, proposed) => decideBoundary(originalLease, expectedRevision, proposed);
  const widenBoundary = async (originalLease, expectedRevision, unitId, request) => {
    requireCondition(originalLease === lease, 'LEASE_INVALID', 'The mutation requires the original owner lease.');
    requireCondition(exact(request, ['plan', 'relationshipId']) && typeof request.relationshipId === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(request.relationshipId),
    'INVALID_INPUT', 'Widening requires a complete plan and an owner-observed relationship ID.');
    requireCondition(request.plan?.unitId === unitId, 'TARGET_MISMATCH', 'The widening plan names another unit.');
    return decideBoundary(originalLease, expectedRevision, request.plan, request.relationshipId);
  };
  const reconcileWaits = async (originalLease, proposedReference) => {
    requireCondition(originalLease === lease, 'LEASE_INVALID', 'The mutation requires the original owner lease.');
    const context = scheduler.readSchedulerContext(lease);
    requireOpen(context);
    requireCondition(validateSnapshotReference(proposedReference).length === 0, 'INVALID_INPUT', 'Wait reconciliation requires a stored snapshot reference.');
    const reference = structuredClone(proposedReference);
    const evidence = scheduler.readSelectionSnapshot(lease, reference);
    const cleared = context.checkpoint.units.filter((unit) => unit.wait && unit.wait.condition.all.every((condition) =>
      waitConditionMet(context.checkpoint, evidence, condition))).map((unit) => unit.unitId);
    if (cleared.length === 0) return { revision: context.checkpoint.revision, transitions: [] };
    const committed = scheduler.commitTransition(lease, context.checkpoint.revision, (checkpoint) => {
      requireOpen({ ...context, checkpoint });
      scheduler.readSelectionSnapshot(lease, reference);
      return { ...checkpoint,
        reservations: checkpoint.reservations.map((row) => cleared.includes(row.unitId) ? { ...row, state: 'planning' } : row),
        units: checkpoint.units.map((row) => cleared.includes(row.unitId)
          ? { ...row, wait: null, admission: null, replanRequired: true, checkedSnapshot: reference,
            lastRequestedPlanGeneration: requestedPlanGenerationFloor(row) } : row) };
    });
    return { revision: committed.revision, transitions: cleared.map((unitId) => ({ unitId, state: 'planning', replanRequired: true })) };
  };
  return Object.freeze({ admitBoundary, widenBoundary, reconcileWaits });
}
