// Pure module-2 records. These validators confer no filesystem or writer authority.
import { createHash } from 'node:crypto';
import { isAbsolute, posix } from 'node:path';
import { eligibleIssueNumbers, SNAPSHOT_SECTIONS, verifySnapshot } from './snapshot-contract.mjs';
import { parseLoopBranchIssue } from './claim-contract.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const text = (value) => typeof value === 'string' && value.length > 0 && !/[\x00-\x1f\x7f]/u.test(value);
const uuid = (value) => typeof value === 'string' && UUID.test(value);
const hash = (value) => typeof value === 'string' && HASH.test(value);
const oid = (value) => typeof value === 'string' && OID.test(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const time = (value) => Number.isSafeInteger(value) && value >= 0;
const path = (value) => text(value) && isAbsolute(value) && posix.normalize(value) === value;
const id = (value) => text(value) && /^[A-Za-z0-9_:=.-]+$/u.test(value);
const nullableId = (value) => value === null || id(value);
function keys(value, names) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const own = Reflect.ownKeys(value);
  return own.every((key) => typeof key === 'string') && own.sort().join('\0') === [...names].sort().join('\0')
    && own.every((key) => { const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor.enumerable && Object.hasOwn(descriptor, 'value'); });
}
function list(value, predicate) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || !predicate(descriptor.value)) return false;
  }
  return true;
}
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
const digest = (value) => createHash('sha256').update(canonical(value)).digest('hex');
const equal = (left, right) => canonical(left) === canonical(right);
const result = (ok, name) => ok ? [] : [`${name} does not match its schema.`];
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)) return false;
  const normalized = value.replace(/(?:\.(\d{1,3}))?Z$/u, (_, fraction) => `.${(fraction ?? '').padEnd(3, '0')}Z`);
  try { return new Date(value).toISOString() === normalized; } catch { return false; }
}
function repository(value, nullable = false) {
  return nullable && value === null || keys(value, ['host', 'owner', 'name', 'nodeId'])
    && text(value.host) && /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/u.test(value.host)
    && text(value.owner) && text(value.name) && /^[A-Za-z0-9_.-]+$/u.test(value.owner) && /^[A-Za-z0-9_.-]+$/u.test(value.name) && nullableId(value.nodeId);
}
function sameRepository(left, right) {
  return repository(left) && repository(right)
    && ['host', 'owner', 'name'].every((key) => left[key].toLowerCase() === right[key].toLowerCase())
    && left.nodeId === right.nodeId;
}
function error(value) {
  return keys(value, ['code', 'message']) && /^[A-Z][A-Z0-9_]*$/u.test(value.code) && text(value.message);
}
function section(value, item) {
  return keys(value, ['items', 'complete', 'error']) && list(value.items, item)
    && (value.complete === true && value.error === null || value.complete === false && error(value.error));
}
function unique(items, key) { return new Set(items.map(key)).size === items.length; }
function sourceIssue(value) { return keys(value, ['number', 'nodeId']) && positive(value.number) && nullableId(value.nodeId); }
function sourceApproval(value) {
  return keys(value, ['issue', 'issueNodeId', 'approvalIssue', 'approvalIssueNodeId', 'eventId', 'actorLogin', 'createdAt', 'kind'])
    && positive(value.issue) && nullableId(value.issueNodeId) && positive(value.approvalIssue) && nullableId(value.approvalIssueNodeId)
    && nullableId(value.eventId) && (value.actorLogin === null || text(value.actorLogin))
    && (value.createdAt === null || date(value.createdAt)) && ['loop-ready', 'repair-parent'].includes(value.kind);
}
function sourceRole(value) {
  return keys(value, ['login', 'userId', 'permission', 'roleName']) && text(value.login) && (value.userId === null || positive(value.userId))
    && [null, 'admin', 'write', 'read', 'none'].includes(value.permission) && (value.roleName === null || text(value.roleName));
}
export function validateSelectionSources(value) {
  const valid = keys(value, ['schema', 'repository', 'issues', 'approvals', 'roles', 'waitIssues', 'waitPullRequests'])
    && value.schema === 'autoloop.selection-sources/1' && repository(value.repository, true)
    && list(value.issues, sourceIssue) && unique(value.issues, (item) => item.number)
    && list(value.approvals, sourceApproval) && unique(value.approvals, (item) => item.issue)
    && list(value.roles, sourceRole) && unique(value.roles, (item) => item.login)
    && section(value.waitIssues, (item) => keys(item, ['number', 'nodeId', 'state']) && positive(item.number)
      && nullableId(item.nodeId) && ['OPEN', 'CLOSED'].includes(item.state))
    && unique(value.waitIssues.items, (item) => item.number)
    && section(value.waitPullRequests, (item) => keys(item, ['number', 'nodeId', 'state', 'headOid', 'baseRefName'])
      && positive(item.number) && nullableId(item.nodeId) && ['OPEN', 'CLOSED', 'MERGED'].includes(item.state)
      && oid(item.headOid) && text(item.baseRefName)) && unique(value.waitPullRequests.items, (item) => item.number);
  return result(valid, 'Selection sources');
}
const EVIDENCE_IDENTITY = ['runId', 'generation', 'checkpointRevision', 'repositoryKey', 'root', 'gitDir', 'commonDir',
  'repository', 'configuredBaseBranch', 'baseRef', 'baseOid', 'headOid', 'configDigest'];
function evidenceIdentity(value) {
  return uuid(value.runId) && positive(value.generation) && positive(value.checkpointRevision) && hash(value.repositoryKey)
    && [value.root, value.gitDir, value.commonDir].every(path) && repository(value.repository) && id(value.repository.nodeId)
    && text(value.configuredBaseBranch) && value.baseRef === `refs/remotes/origin/${value.configuredBaseBranch}`
    && oid(value.baseOid) && oid(value.headOid) && hash(value.configDigest);
}
export function validateSelectionSnapshot(value) {
  return result(keys(value, ['schema', ...EVIDENCE_IDENTITY, 'snapshot', 'sources']) && value.schema === 'autoloop.selection-snapshot/1'
    && evidenceIdentity(value) && verifySnapshot(value.snapshot) && validateSelectionSources(value.sources).length === 0
    && sameRepository(value.repository, value.sources.repository)
    && value.snapshot.sections.repo.complete === true
    && value.snapshot.sections.repo.items[0].nameWithOwner.toLowerCase() === `${value.repository.owner}/${value.repository.name}`.toLowerCase()
    && value.snapshot.sections.tree.complete === true && value.snapshot.sections.tree.items[0].headOid === value.headOid, 'Selection snapshot');
}
export function validateSnapshotReference(value) {
  return result(keys(value, ['schema', ...EVIDENCE_IDENTITY, 'snapshotGeneration', 'snapshotFingerprint', 'contentDigest'])
    && value.schema === 'autoloop.snapshot-reference/1' && evidenceIdentity(value)
    && [value.snapshotGeneration, value.snapshotFingerprint, value.contentDigest].every(hash), 'Snapshot reference');
}
export function selectionSnapshotReference(value) {
  if (validateSelectionSnapshot(value).length) throw new TypeError('Selection snapshot does not match its schema.');
  return { schema: 'autoloop.snapshot-reference/1', ...Object.fromEntries(EVIDENCE_IDENTITY.map((key) => [key, value[key]])),
    snapshotGeneration: value.snapshot.generation, snapshotFingerprint: value.snapshot.fingerprint, contentDigest: digest(value) };
}
function subject(value) {
  return keys(value, ['repositoryKey', 'repository', 'issue', 'issueNodeId', 'issueBodyDigest', 'approval'])
    && hash(value.repositoryKey) && repository(value.repository) && id(value.repository.nodeId) && positive(value.issue)
    && id(value.issueNodeId) && hash(value.issueBodyDigest)
    && keys(value.approval, ['kind', 'issue', 'issueNodeId', 'eventId', 'actorLogin', 'actorUserId', 'createdAt'])
    && ['loop-ready', 'repair-parent'].includes(value.approval.kind) && positive(value.approval.issue)
    && [value.approval.issueNodeId, value.approval.eventId].every(id) && positive(value.approval.actorUserId)
    && text(value.approval.actorLogin) && date(value.approval.createdAt)
    && (value.approval.kind !== 'loop-ready' || value.approval.issue === value.issue && value.approval.issueNodeId === value.issueNodeId);
}
export function validateIssueAuthorization(value) {
  return result(keys(value, ['schema', 'subject', 'authorizationDigest', 'evidenceDigest', 'snapshot'])
    && value.schema === 'autoloop.issue-authorization/1' && subject(value.subject)
    && value.authorizationDigest === digest(value.subject) && hash(value.evidenceDigest)
    && validateSnapshotReference(value.snapshot).length === 0 && value.subject.repositoryKey === value.snapshot.repositoryKey
    && sameRepository(value.subject.repository, value.snapshot.repository), 'Issue authorization');
}
// The exact evidence tuple is shared with the selection provider. The digest
// binds normalized policy facts to the upstream IDs that normalization omits.
export function issueAuthorizationEvidence(value, evidence) {
  if (validateIssueAuthorization(value).length || validateSelectionSnapshot(evidence).length) return null;
  const { subject: proposed } = value; const { approval } = proposed;
  const { snapshot, sources } = evidence;
  if (!equal(value.snapshot, selectionSnapshotReference(evidence)) || snapshot.invalidation.reasonCodes.length
    || SNAPSHOT_SECTIONS.some((name) => !snapshot.sections[name].complete)
    || !eligibleIssueNumbers(snapshot)?.includes(proposed.issue)) return null;
  const queue = snapshot.sections.queue.items.find((item) => item.number === proposed.issue);
  const openIssue = snapshot.sections.openIssues.items.find((item) => item.number === proposed.issue);
  const role = snapshot.sections.authorVerification.items.find((item) => item.login === approval.actorLogin);
  const issueSource = sources.issues.find((item) => item.number === proposed.issue);
  const approvalSource = sources.approvals.find((item) => item.issue === proposed.issue);
  const roleSource = sources.roles.find((item) => item.login === approval.actorLogin);
  if (!queue || !openIssue || !role || !issueSource || !approvalSource || !roleSource
    || queue.body !== openIssue.body || openIssue.bodySha256 !== proposed.issueBodyDigest
    || queue.provenance.labeledBy !== approval.actorLogin || queue.provenance.labeledAt !== approval.createdAt
    || role.permission !== roleSource.permission || role.roleName !== roleSource.roleName
    || !['admin', 'write'].includes(role.permission) || roleSource.userId !== approval.actorUserId
    || issueSource.nodeId !== proposed.issueNodeId || approvalSource.issueNodeId !== proposed.issueNodeId
    || approvalSource.approvalIssue !== approval.issue || approvalSource.approvalIssueNodeId !== approval.issueNodeId
    || approvalSource.kind !== approval.kind || approvalSource.eventId !== approval.eventId
    || approvalSource.actorLogin !== approval.actorLogin || approvalSource.createdAt !== approval.createdAt
    || (queue.repair ? approval.kind !== 'repair-parent' || approval.issue !== queue.repair.parent : approval.kind !== 'loop-ready')) return null;
  return { queue, openIssue, role, issueSource, approvalSource, roleSource };
}
export function validateIssueAuthorizationEvidence(value, evidence) {
  const tuple = issueAuthorizationEvidence(value, evidence);
  return result(tuple !== null && value.evidenceDigest === digest(tuple), 'Issue authorization evidence');
}
function boundaryPath(value) {
  if (!text(value) || value.startsWith('/') || /[\\:*?\[\]{}]/u.test(value) || value.normalize('NFC') !== value) return false;
  const stripped = value.endsWith('/') ? value.slice(0, -1) : value;
  return stripped.length > 0 && stripped.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..'
    && part.toLowerCase() !== '.git') && posix.normalize(stripped) === stripped;
}
function boundary(value, empty = false) { return list(value, boundaryPath) && (empty || value.length > 0) && unique(value, (item) => item); }
function plan(value) {
  return keys(value, ['planGeneration', 'planDigest', 'baseOid', 'boundary']) && positive(value.planGeneration)
    && hash(value.planDigest) && oid(value.baseOid) && boundary(value.boundary);
}
export function validateSelectionPlan(value) { return result(plan(value), 'Selection plan'); }
export function validateAdmission(value) {
  return result(keys(value, ['schema', 'runId', 'unitId', 'unitGeneration', 'planGeneration', 'planDigest', 'baseOid', 'boundary', 'reservationRevision'])
    && value.schema === 'autoloop.admission/1' && uuid(value.runId) && uuid(value.unitId) && positive(value.unitGeneration)
    && positive(value.planGeneration) && hash(value.planDigest) && oid(value.baseOid) && boundary(value.boundary)
    && positive(value.reservationRevision), 'Admission');
}
export function validateWorktreeBinding(value) {
  return result(keys(value, ['root', 'gitDir', 'commonDir', 'repositoryKey', 'branch', 'baseOid', 'createdByRun', 'unitId', 'unitGeneration'])
    && [value.root, value.gitDir, value.commonDir].every(path) && hash(value.repositoryKey) && positive(parseLoopBranchIssue(value.branch))
    && oid(value.baseOid) && uuid(value.createdByRun) && uuid(value.unitId) && positive(value.unitGeneration), 'Worktree binding');
}
function processIdentity(value) {
  return keys(value, ['pid', 'start', 'bootId']) && positive(value.pid) && text(value.start) && text(value.bootId)
    && (uuid(value.bootId) && /^\d+$/u.test(value.start) || /^darwin:\d+:\d+$/u.test(value.bootId)
      && /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/u.test(value.start));
}
export function validateAllocationCreator(value) {
  return result(keys(value, ['process', 'pgid', 'groupLeader']) && processIdentity(value.process) && positive(value.pgid)
    && processIdentity(value.groupLeader) && value.groupLeader.pid === value.pgid, 'Allocation creator');
}
function allocationHistoryEntry(value) {
  if (!keys(value, ['attempt', 'creator', 'receipt'])) return false;
  const { receipt } = value;
  return positive(value.attempt) && validateAllocationCreator(value.creator).length === 0
    && keys(receipt, ['externalId', 'observationDigest', 'observedAt'])
    && (receipt.externalId === null || text(receipt.externalId) && /^[A-Za-z0-9._:-]+$/u.test(receipt.externalId))
    && hash(receipt.observationDigest) && time(receipt.observedAt);
}
export function validateAllocation(value) {
  return result(keys(value, ['intent', 'creator', 'creatorHistory']) && keys(value.intent,
    ['operationId', 'runId', 'unitId', 'unitGeneration', 'repositoryKey', 'root', 'branch', 'baseOid'])
    && [value.intent.operationId, value.intent.runId, value.intent.unitId].every(uuid) && positive(value.intent.unitGeneration)
    && hash(value.intent.repositoryKey) && path(value.intent.root) && positive(parseLoopBranchIssue(value.intent.branch))
    && oid(value.intent.baseOid) && (value.creator === null || validateAllocationCreator(value.creator).length === 0)
    && list(value.creatorHistory, allocationHistoryEntry) && value.creatorHistory.every((entry, index) => entry.attempt === index + 1), 'Allocation');
}
function condition(value) {
  if (value?.on === 'unit-release') return keys(value, ['on', 'unitId', 'unitGeneration']) && uuid(value.unitId) && positive(value.unitGeneration);
  return keys(value, ['on', 'number']) && ['pr', 'issue'].includes(value.on) && positive(value.number);
}
export function validateSelectionWait(value) {
  return result(keys(value, ['schema', 'code', 'unitId', 'conflicts', 'condition', 'requestedPlan', 'snapshot', 'createdRevision'])
    && value.schema === 'autoloop.selection-wait/1' && /^[A-Z][A-Z0-9_]*$/u.test(value.code) && uuid(value.unitId)
    && list(value.conflicts, (item) => keys(item, ['type', 'id', 'paths']) && ['unit', 'pr', 'issue'].includes(item.type)
      && (item.type === 'unit' ? uuid(item.id) : positive(item.id)) && boundary(item.paths, true)) && value.conflicts.length > 0
    && keys(value.condition, ['all']) && list(value.condition.all, condition) && value.condition.all.length > 0
    && unique(value.condition.all, canonical) && plan(value.requestedPlan) && validateSnapshotReference(value.snapshot).length === 0
    && positive(value.createdRevision), 'Selection wait');
}
export function validateSelectionUnit(value) {
  return result(keys(value, ['schema', 'runId', 'repositoryKey', 'unitId', 'unitGeneration', 'allocation', 'plan', 'admission', 'wait',
    'checkedSnapshot', 'replanRequired', 'policy', 'disposition']) && value.schema === 'autoloop.selection-unit/1'
    && uuid(value.runId) && hash(value.repositoryKey) && uuid(value.unitId) && positive(value.unitGeneration)
    && (value.allocation === null || validateAllocation(value.allocation).length === 0)
    && (value.plan === null || plan(value.plan)) && (value.admission === null || validateAdmission(value.admission).length === 0)
    && (value.wait === null || validateSelectionWait(value.wait).length === 0) && validateSnapshotReference(value.checkedSnapshot).length === 0
    && typeof value.replanRequired === 'boolean' && keys(value.policy, ['authorize'])
    && list(value.policy.authorize, (item) => keys(item, ['file', 'glob']) && boundaryPath(item.file) && text(item.glob))
    && unique(value.policy.authorize, canonical)
    && (value.disposition === null || keys(value.disposition, ['kind', 'observationDigest', 'observedAt', 'revision'])
      && value.disposition.kind === 'no-work' && hash(value.disposition.observationDigest) && time(value.disposition.observedAt)
      && positive(value.disposition.revision)), 'Selection unit');
}
export function validateReservation(value) {
  return result(keys(value, ['schema', 'runId', 'unitId', 'unitGeneration', 'issue', 'repositoryKey', 'issueAuthorization', 'slot', 'baseOid',
    'worktree', 'paths', 'state', 'createdRevision']) && value.schema === 'autoloop.reservation/1'
    && uuid(value.runId) && uuid(value.unitId) && positive(value.unitGeneration) && positive(value.issue) && hash(value.repositoryKey)
    && validateIssueAuthorization(value.issueAuthorization).length === 0 && [1, 2].includes(value.slot) && oid(value.baseOid)
    && (value.worktree === null || validateWorktreeBinding(value.worktree).length === 0) && boundary(value.paths, true)
    && ['planning', 'admitted', 'waiting', 'recovering', 'released'].includes(value.state) && positive(value.createdRevision), 'Reservation');
}
export function hasRetainedSelection(checkpoint) {
  return (checkpoint.reservations ?? []).some((item) => item.state !== 'released')
    || (checkpoint.units ?? []).some((unit) => unit.disposition === null);
}
export function validateSelectionRecords(checkpoint) {
  const { units, reservations } = checkpoint;
  if (!list(units, (value) => validateSelectionUnit(value).length === 0)
    || !list(reservations, (value) => validateReservation(value).length === 0)
    || units.length !== reservations.length || !unique(units, (unit) => unit.unitId)
    || !unique(reservations, (reservation) => reservation.unitId)) return ['Selection records are invalid.'];
  const active = reservations.filter((value) => value.state !== 'released');
  if (active.length > 2 || !unique(active, (value) => value.issue) || !unique(active, (value) => value.slot)) return ['Selection slots or issues are invalid.'];
  if (active.some((value) => !sameRepository(value.issueAuthorization.subject.repository, active[0].issueAuthorization.subject.repository))) {
    return ['Active selection upstream repositories are inconsistent.'];
  }
  for (const reservation of reservations) {
    const unit = units.find((value) => value.unitId === reservation.unitId);
    if (!unit || [unit, reservation].some((item) => item.runId !== checkpoint.runId || item.repositoryKey !== checkpoint.repositoryKey)
      || unit.unitGeneration !== reservation.unitGeneration || reservation.createdRevision > checkpoint.revision
      || reservation.issueAuthorization.subject.issue !== reservation.issue
      || reservation.issueAuthorization.subject.repositoryKey !== checkpoint.repositoryKey
      || reservation.issueAuthorization.snapshot.runId !== checkpoint.runId
      || unit.checkedSnapshot.runId !== checkpoint.runId || unit.checkedSnapshot.repositoryKey !== checkpoint.repositoryKey
      || !sameRepository(unit.checkedSnapshot.repository, reservation.issueAuthorization.subject.repository)
      || unit.checkedSnapshot.generation > checkpoint.generation || unit.checkedSnapshot.checkpointRevision > checkpoint.revision) return ['Selection pair identity is invalid.'];
    if (unit.allocation) {
      const { intent } = unit.allocation; const effect = checkpoint.outbox?.[intent.operationId];
      if (intent.runId !== unit.runId || intent.unitId !== unit.unitId || intent.unitGeneration !== unit.unitGeneration
        || intent.repositoryKey !== unit.repositoryKey || intent.baseOid !== reservation.baseOid
        || parseLoopBranchIssue(intent.branch) !== reservation.issue || !effect || effect.kind !== 'worktree.create'
        || effect.unitId !== unit.unitId || effect.unitGeneration !== unit.unitGeneration || effect.inputDigest !== digest(intent)
        || effect.expectedHead !== intent.baseOid || effect.target?.type !== 'external' || effect.target.id !== unit.unitId) return ['Allocation effect identity is invalid.'];
      const history = unit.allocation.creatorHistory;
      if (history.length !== effect.attempt - 1 || effect.phase === 'prepared' && effect.attempt > 1
        && (unit.allocation.creator !== null || !equal(history.at(-1).receipt, effect.receipt))) return ['Allocation attempt history is invalid.'];
    }
    if (reservation.worktree) {
      const worktree = reservation.worktree; const intent = unit.allocation?.intent;
      if (!intent || ['root', 'branch', 'baseOid'].some((key) => worktree[key] !== intent[key])
        || worktree.commonDir !== unit.checkedSnapshot.commonDir || worktree.repositoryKey !== unit.repositoryKey
        || worktree.createdByRun !== unit.runId || worktree.unitId !== unit.unitId || worktree.unitGeneration !== unit.unitGeneration
        || checkpoint.outbox[intent.operationId].phase !== 'succeeded') return ['Worktree binding is invalid.'];
    }
    if (unit.allocation && checkpoint.outbox[unit.allocation.intent.operationId].phase === 'succeeded' && !reservation.worktree) return ['A completed allocation needs its worktree binding.'];
    if (unit.admission && unit.plan && unit.plan.baseOid !== unit.checkedSnapshot.baseOid) return ['The admitted plan does not match its checked base.'];
    if (unit.admission) {
      const admission = unit.admission;
      if (reservation.state !== 'admitted' || checkpoint.state === 'recovering' || !reservation.worktree || !unit.plan || unit.wait !== null || unit.replanRequired
        || unit.checkedSnapshot.root !== reservation.worktree.root || unit.checkedSnapshot.gitDir !== reservation.worktree.gitDir
        || admission.runId !== unit.runId || admission.unitId !== unit.unitId || admission.unitGeneration !== unit.unitGeneration
        || ['planGeneration', 'planDigest', 'baseOid', 'boundary'].some((key) => !equal(admission[key], unit.plan[key]))
        || !equal(admission.boundary, reservation.paths) || admission.reservationRevision > checkpoint.revision) return ['Admission does not match its plan and paths.'];
    } else if (reservation.state === 'admitted') return ['An admitted reservation needs admission.'];
    if (unit.wait && (reservation.state !== 'waiting' || unit.admission !== null || unit.wait.unitId !== unit.unitId
      || unit.wait.createdRevision > checkpoint.revision || !equal(unit.wait.snapshot, unit.checkedSnapshot))) return ['Selection wait is invalid.'];
    if (reservation.state === 'waiting' && unit.wait === null) return ['A waiting reservation needs a wait.'];
    if (['waiting', 'recovering', 'released'].includes(reservation.state) && unit.admission !== null) return ['Retained or released work cannot use admission.'];
    if (unit.disposition && (reservation.state !== 'released' || unit.disposition.revision > checkpoint.revision
      || reservation.paths.length !== 0 || unit.wait !== null || unit.admission !== null)) return ['Selection disposition is invalid.'];
    if (reservation.state === 'released' && unit.disposition === null) return ['Path release needs disposition.'];
    for (const worker of Array.isArray(checkpoint.workers) ? checkpoint.workers : []) if (worker?.unitId === unit.unitId
      && (worker.runId !== unit.runId || worker.unitGeneration !== unit.unitGeneration || !reservation.worktree
        || worker.worktreeGitDir !== reservation.worktree.gitDir)) return ['Selection worker binding is invalid.'];
  }
  for (const effect of Object.values(checkpoint.outbox ?? {})) if (effect?.kind === 'worktree.create'
    && !units.some((unit) => unit.allocation?.intent.operationId === effect.operationId)) return ['A worktree effect needs its allocation intent.'];
  return [];
}
