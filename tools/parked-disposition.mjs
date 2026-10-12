#!/usr/bin/env node
// autoloop — parked-disposition.mjs
//
// What each open unit waits for, projected from its local step record and the
// retained prime snapshot. Pure: no file, process or GitHub access.
//
// Usage:
//   node parked-disposition.mjs --self-test

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BLOCKING_LABELS } from './lifecycle-contract.mjs';
import {
  completeSection, createSnapshot, incompleteSection, invalidateSnapshot, issueSnapshotItem,
  SNAPSHOT_SECTIONS, unitCard, verifySnapshot,
} from './snapshot-contract.mjs';

// The sections a unit's labels are read from (unitCard reads queue, then open
// issues). An issue mutation invalidates both together.
export const DISPOSITION_SECTIONS = Object.freeze(['openIssues', 'queue']);
// Bookkeeping marks, not running work: their age is not a running time.
export const MARK_STEPS = Object.freeze(['00-reconcile', '11-record']);

// How many times the unit entered its current step: runs of that step in the
// record, a re-announcement right after itself not counted (#427 went plan,
// plan-review, plan, plan: v2).
export function stepAttempt(steps) {
  const current = steps.at(-1)?.step;
  let attempts = 0;
  steps.forEach((entry, index) => {
    if (entry.step === current && steps[index - 1]?.step !== current) attempts += 1;
  });
  return attempts;
}

// Whether the retained snapshot may speak for the units' labels: 'current'
// when verified, from this repository, not future-dated, with complete label
// sections; 'history' when only an invalidation stands between it and current
// (its retained items are dated observations); otherwise 'none'. No age
// threshold: per-unit freshness is decided against the unit's own record.
export function snapshotAuthority({ snapshot, repository, nowMs }) {
  const none = (reason, scannedAtMs = null) => ({ authority: 'none', reason, scannedAtMs });
  if (snapshot === null || snapshot === undefined) return none('ABSENT');
  if (!verifySnapshot(snapshot)) return none('UNVERIFIED');
  const scannedAtMs = Date.parse(snapshot.scannedAt);
  if (!(scannedAtMs <= nowMs)) return none('FUTURE', scannedAtMs);
  const repo = snapshot.sections.repo;
  const identity = repo.items.length === 1 && (repo.complete || repo.error.code === 'SNAPSHOT_INVALIDATED')
    ? repo.items[0].nameWithOwner.toLowerCase() : null;
  if (identity === null || typeof repository !== 'string') return none('UNKNOWN_REPOSITORY', scannedAtMs);
  if (identity !== repository.toLowerCase()) return none('FOREIGN', scannedAtMs);
  if (DISPOSITION_SECTIONS.some((name) => snapshot.invalidation.sections.includes(name))) {
    return { authority: 'history', reason: 'INVALIDATED', scannedAtMs };
  }
  if (DISPOSITION_SECTIONS.some((name) => snapshot.sections[name].complete !== true)) {
    return none('INCOMPLETE', scannedAtMs);
  }
  return { authority: 'current', reason: 'CURRENT', scannedAtMs };
}

// A human or dependency gate first, then a wait, then repair work.
export function observedDisposition(labels) {
  if (!Array.isArray(labels)) return null;
  const blocking = labels.filter((label) => BLOCKING_LABELS.has(label)).sort();
  if (blocking.length) return { disposition: 'blocked', labels: blocking };
  if (labels.includes('loop-waiting')) return { disposition: 'waiting', labels: ['loop-waiting'] };
  if (labels.includes('loop-repair')) return { disposition: 'repair', labels: ['loop-repair'] };
  return null;
}

// The delivered card's caption, from the validated merge.policy. It names what
// the delivery waits for and grants nothing; an unknown policy reads neutral.
const MERGE_CAPTIONS = Object.freeze({
  manual: 'awaits human merge', auto: 'automatic merge pending', ratified: 'ratified merge decision pending',
});

export function mergeCaption(policy) {
  return typeof policy === 'string' && Object.hasOwn(MERGE_CAPTIONS, policy)
    ? MERGE_CAPTIONS[policy] : 'merge disposition pending';
}

function latestStep(record) {
  if (record === null || typeof record !== 'object'
    || !Number.isSafeInteger(record.issue) || record.issue < 1 || !Array.isArray(record.steps)) return null;
  const last = record.steps.at(-1);
  return last !== null && typeof last === 'object' && typeof last.step === 'string' ? last : null;
}

// A delivered card leaves its merge pending, not the unit closed. A legacy
// record closed as delivered is pending only while a scan taken after its
// card positively observes the issue's open PR; it is never rewritten.
function pendingDelivery(record, snapshot, authority) {
  const { pending, closed } = record;
  if (!closed) {
    return pending?.outcome === 'delivered' && Number.isFinite(pending.atMs)
      && (pending.pr === null || (Number.isSafeInteger(pending.pr) && pending.pr > 0))
      ? { pr: pending.pr, policy: typeof pending.policy === 'string' ? pending.policy : null,
        reason: typeof pending.reason === 'string' && pending.reason ? pending.reason : null,
        atMs: pending.atMs, observedAtMs: null }
      : null;
  }
  if (closed.outcome !== 'delivered' || !Number.isFinite(closed.atMs) || authority.authority === 'none'
    || authority.scannedAtMs < closed.atMs || snapshot.sections.openPrs.complete !== true) return null;
  const pr = unitCard(snapshot, record.issue).pullRequest?.number ?? null;
  return pr === null ? null : { pr, policy: null, reason: null, atMs: closed.atMs, observedAtMs: authority.scannedAtMs };
}

function lastSeen(step, pending) {
  const times = [step.startedAtMs, step.returnedAtMs, step.waiting?.atMs, pending?.atMs].filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}

// Every open record stays: only a terminal card (record.closed) ends a unit,
// and a delivered card leaves it merge-pending. Age, a record step, snapshot
// absence or an unreadable snapshot qualify the local state; none hides it.
// Local work newer than the scan outranks it.
export function projectParked({ records, snapshot = null, repository = null, nowMs, sinceMs = null }) {
  const authority = snapshotAuthority({ snapshot, repository, nowMs });
  const latest = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const step = latestStep(record);
    if (step === null) continue;
    const pending = pendingDelivery(record, snapshot, authority);
    if (record.closed && pending === null) continue;
    const seen = lastSeen(step, pending);
    const kept = latest.get(record.issue);
    if (kept && (kept.lastSeenAtMs ?? -Infinity) >= (seen ?? -Infinity)) continue;
    latest.set(record.issue, { issue: record.issue, ...step, attempt: stepAttempt(record.steps), lastSeenAtMs: seen, pending });
  }
  const units = [...latest.values()].sort((left, right) => left.issue - right.issue).map((unit) => {
    const delivered = unit.pending !== null && !(unit.startedAtMs > unit.pending.atMs);
    const local = unit.lastSeenAtMs === null ? 'undated'
      : sinceMs !== null && unit.lastSeenAtMs < sinceMs ? 'earlier-run'
        : MARK_STEPS.includes(unit.step) || delivered ? 'mark' : 'current';
    const fresh = authority.authority !== 'none'
      && (unit.lastSeenAtMs === null || authority.scannedAtMs >= unit.lastSeenAtMs);
    const seen = fresh ? observedDisposition(unitCard(snapshot, unit.issue).labels) : null;
    return {
      ...unit, local,
      observed: seen && { ...seen, atMs: authority.scannedAtMs, current: authority.authority === 'current' },
    };
  });
  const shown = new Set(units.map((unit) => unit.issue));
  const blocked = snapshot?.sections?.blockedIssues;
  const humanWaits = authority.authority === 'current' && blocked.complete === true
    ? blocked.items.map((item) => item.number).filter((number) => !shown.has(number)).slice(0, 3)
    : [];
  return { authority, units, humanWaits };
}

function selfTest() {
  const at = (day, hh, mm) => new Date(2026, 9, day, hh, mm).getTime();
  const iso = (ms) => new Date(ms).toISOString();
  const repo = { owner: 'acme', name: 'widgets', nameWithOwner: 'acme/widgets', defaultBranch: 'main' };
  const tree = { dirtyEntries: [], dirtyPaths: 0, branch: 'main', headOid: 'a'.repeat(40) };
  const issue = (number, labels) => issueSnapshotItem({
    number, title: `Issue ${number}`, body: '', updatedAt: '2026-10-11T08:00:00Z',
    labels: labels.map((name) => ({ name })),
  });
  const pullRequest = (issueNumber, number) => ({
    number, title: 'loop unit', body: `Closes #${issueNumber}`, isDraft: false, reviewDecision: 'APPROVED',
    headRefName: `feat/gh-${issueNumber}-loop-unit`, headRefOid: 'b'.repeat(40), baseRefName: 'main',
    mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', mergedAt: null, updatedAt: '2026-10-12T08:00:00Z',
    author: 'actor', headRepository: 'acme/widgets', statusCheckState: 'SUCCESS', statusCheckRollup: [],
    issue: issueNumber, orphanCandidate: false, ownership: 'loop',
  });
  const snapshotOf = ({ scannedAtMs, issues, owner = repo, openIssues = null, openPrs = completeSection([]) }) => {
    const sections = Object.fromEntries(SNAPSHOT_SECTIONS.map((name) => [name, completeSection([])]));
    sections.repo = completeSection([owner]);
    sections.tree = completeSection([tree]);
    sections.openPrs = openPrs;
    sections.openIssues = openIssues ?? completeSection(issues);
    sections.blockedIssues = completeSection(issues.filter((item) => item.labels.includes('loop-blocked')));
    return createSnapshot({ scannedAt: iso(scannedAtMs), sections });
  };
  const deepFreeze = (value) => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.values(value).forEach(deepFreeze);
      Object.freeze(value);
    }
    return value;
  };
  const record = (issueNumber, ...steps) => deepFreeze({ issue: issueNumber, steps });
  const safely = (run) => {
    try {
      return run();
    } catch (error) {
      return { threw: error.message };
    }
  };
  const nowMs = at(12, 10, 30);
  const scanMs = at(12, 10, 20);
  const sinceMs = at(11, 7, 0);
  const marks = [
    record(501, { step: '00-reconcile', startedAtMs: at(11, 8, 0) }),
    record(502, { step: '00-reconcile', startedAtMs: at(11, 8, 0) }),
    record(503, { step: '00-reconcile', startedAtMs: at(11, 8, 0) }),
    record(504, { step: '00-reconcile', startedAtMs: at(11, 8, 0) }),
  ];
  const issues = [
    issue(501, ['human:decide', 'loop-blocked', 'loop-started']),
    issue(502, ['loop-started', 'loop-waiting']),
    issue(503, ['loop-repair']),
    issue(504, ['needs-secret']),
    issue(510, ['loop-blocked']),
  ];
  const snapshot = snapshotOf({ scannedAtMs: scanMs, issues });
  const project = (options) => safely(() => projectParked({
    records: marks, snapshot, repository: 'acme/widgets', nowMs, sinceMs, ...options,
  }));
  const unit = (projection, number) => projection?.units?.find((entry) => entry.issue === number) ?? null;
  const observed = (projection, number) => JSON.stringify(unit(projection, number)?.observed ?? null);

  const current = project({});
  const newer = project({
    records: [
      record(520, { step: '05-implement', stepId: 's1', dispatchId: 'd1', model: 'claude-opus-5-5', role: 'implement',
        startedAtMs: at(12, 10, 25) }),
      record(521, { step: '02-plan', staged: true, model: 'gpt-6-astra', startedAtMs: at(12, 10, 0) },
        { step: '07-diff-review', stepId: 's2', dispatchId: 'd2', model: 'claude-opus-5-5', role: 'fix',
          reviewRound: 2, round: null, startedAtMs: at(12, 10, 5) }),
    ],
    snapshot: snapshotOf({ scannedAtMs: scanMs, issues: [issue(520, ['loop-blocked']), issue(521, ['loop-waiting'])] }),
  });
  const tampered = JSON.parse(JSON.stringify(snapshot));
  tampered.sections.openIssues.items[0].labels = ['loop-started'];
  const withoutAuthority = [
    ['UNVERIFIED', project({ snapshot: tampered })],
    ['UNVERIFIED', project({ snapshot: { kind: 'autoloop-repository-snapshot' } })],
    ['FOREIGN', project({ snapshot: snapshotOf({ scannedAtMs: scanMs, issues,
      owner: { owner: 'other', name: 'widgets', nameWithOwner: 'other/widgets', defaultBranch: 'main' } }) })],
    ['FUTURE', project({ snapshot: snapshotOf({ scannedAtMs: nowMs + 60_000, issues }) })],
    ['UNKNOWN_REPOSITORY', project({ repository: null })],
    ['INCOMPLETE', project({ snapshot: snapshotOf({ scannedAtMs: scanMs, issues,
      openIssues: incompleteSection('SCAN_FAILED', 'open issues failed', issues) }) })],
    ['ABSENT', project({ snapshot: null })],
  ];
  const history = project({ snapshot: invalidateSnapshot(snapshot, 'ISSUE_MUTATION') });
  const visible = project({
    records: [
      record(530, { step: '08-fix', round: '1/5', model: 'claude-opus-5-5', startedAtMs: at(10, 9, 51) }),
      record(531, { step: '09-gate', startedAtMs: at(12, 9, 0) }, { step: '11-record', startedAtMs: at(12, 9, 40) }),
      deepFreeze({ issue: 532, steps: [{ step: '05-implement', startedAtMs: at(12, 9, 0) }],
        closed: { outcome: 'shipped', atMs: at(12, 9, 30) } }),
      record(533, { step: '05-implement', model: 'claude-opus-5-5', startedAtMs: at(12, 9, 0) }),
    ],
  });
  const duplicated = project({
    records: [...marks,
      record(501, { step: '00-reconcile', startedAtMs: at(10, 8, 0) }),
      record(533, { step: '05-implement', startedAtMs: at(12, 9, 0) })],
  });
  const delivery = (pr, policy, reason, atMs) => ({ outcome: 'delivered', pr, policy, reason, atMs });
  const delivered = project({
    records: [
      deepFreeze({ issue: 612, steps: [{ step: '09-gate', startedAtMs: at(12, 9, 0) },
        { step: '11-record', startedAtMs: at(12, 9, 50) }], pending: delivery(700, 'auto', 'checks pending', at(12, 9, 45)) }),
      deepFreeze({ issue: 613, steps: [{ step: '10-publish', startedAtMs: at(12, 9, 0) }],
        pending: delivery(701, 'manual', null, at(12, 9, 30)) }),
      deepFreeze({ issue: 614, steps: [{ step: '11-record', startedAtMs: at(12, 9, 0) }],
        closed: { outcome: 'shipped', atMs: at(12, 9, 40) } }),
      deepFreeze({ issue: 615, steps: [{ step: '09-gate', startedAtMs: at(12, 9, 0) }],
        pending: { outcome: 'delivered', pr: 'x', atMs: 'later' } }),
    ],
  });
  const legacyDelivered = deepFreeze({ issue: 640, steps: [{ step: '09-gate', startedAtMs: at(12, 9, 0) }],
    closed: { outcome: 'delivered', atMs: at(12, 9, 30) } });
  const legacyMerged = deepFreeze({ issue: 641, steps: [{ step: '09-gate', startedAtMs: at(12, 9, 0) }],
    closed: { outcome: 'delivered', atMs: at(12, 9, 30) } });
  const withPr = (options) => snapshotOf({ scannedAtMs: scanMs, issues, openPrs: completeSection([pullRequest(640, 740)]), ...options });
  const legacyDeliveries = [
    project({ records: [legacyDelivered, legacyMerged], snapshot: withPr({}) }),
    project({ records: [legacyDelivered], snapshot: null }),
    project({ records: [legacyDelivered], snapshot: withPr({ scannedAtMs: at(12, 9, 10) }) }),
    project({ records: [legacyDelivered], snapshot: withPr({
      openPrs: incompleteSection('SCAN_FAILED', 'open PRs failed', [pullRequest(640, 740)]) }) }),
  ];
  const legacy = project({
    records: [
      record(540, { step: '05-implement', model: 'claude-opus-5-5', round: null, fallback: false, staged: false,
        startedAtMs: at(12, 9, 0) }),
      record(541, { step: '02-plan' }),
      { issue: 'x', steps: [{ step: '02-plan', startedAtMs: 1 }] },
      { issue: 542, steps: [] },
      { issue: 543, steps: [null] },
      null,
      'not a record',
    ],
  });

  const checks = [
    ['the snapshot fixtures are real, verified prime snapshots',
      verifySnapshot(snapshot) && unitCard(snapshot, 501).labels.includes('human:decide')
        && verifySnapshot(withPr({})) && unitCard(withPr({}), 640).pullRequest?.number === 740],
    ['a current snapshot from this repository is authority',
      JSON.stringify(safely(() => snapshotAuthority({ snapshot, repository: 'ACME/Widgets', nowMs })))
        === JSON.stringify({ authority: 'current', reason: 'CURRENT', scannedAtMs: scanMs })],
    ['labels classify blocked, waiting and repair, with human gates first', JSON.stringify(safely(() => [
      observedDisposition(['loop-started', 'human:decide', 'loop-blocked']),
      observedDisposition(['needs-secret', 'loop-waiting']),
      observedDisposition(['loop-waiting']),
      observedDisposition(['loop-repair']),
      observedDisposition(['loop-started', 'loop:05-implement']),
      observedDisposition(null),
    ])) === JSON.stringify([
      { disposition: 'blocked', labels: ['human:decide', 'loop-blocked'] },
      { disposition: 'blocked', labels: ['needs-secret'] },
      { disposition: 'waiting', labels: ['loop-waiting'] },
      { disposition: 'repair', labels: ['loop-repair'] },
      null,
      null,
    ])],
    ['a local reconcile mark yields to a current blocked, waiting or repair observation',
      observed(current, 501) === JSON.stringify({ disposition: 'blocked', labels: ['human:decide', 'loop-blocked'], atMs: scanMs, current: true })
        && observed(current, 502) === JSON.stringify({ disposition: 'waiting', labels: ['loop-waiting'], atMs: scanMs, current: true })
        && observed(current, 503) === JSON.stringify({ disposition: 'repair', labels: ['loop-repair'], atMs: scanMs, current: true })
        && observed(current, 504) === JSON.stringify({ disposition: 'blocked', labels: ['needs-secret'], atMs: scanMs, current: true })
        && [501, 502, 503, 504].every((number) => unit(current, number)?.local === 'mark'
          && unit(current, number).step === '00-reconcile' && unit(current, number).lastSeenAtMs === at(11, 8, 0))],
    ['newer local work outranks an older snapshot, and an active attempt keeps its model, role and round',
      unit(newer, 520)?.observed === null && unit(newer, 520)?.local === 'current'
        && unit(newer, 520)?.model === 'claude-opus-5-5' && unit(newer, 520)?.dispatchId === 'd1'
        && observed(newer, 521) === JSON.stringify({ disposition: 'waiting', labels: ['loop-waiting'], atMs: scanMs, current: true })
        && unit(newer, 521)?.step === '07-diff-review' && unit(newer, 521)?.role === 'fix'
        && unit(newer, 521)?.reviewRound === 2 && unit(newer, 521)?.model === 'claude-opus-5-5'
        && unit(newer, 521)?.attempt === 1],
    ['a unit absent from the snapshot stays visible with its own local state',
      unit(visible, 533)?.observed === null && unit(visible, 533)?.local === 'current'
        && unitCard(snapshot, 533).open === false],
    ['invalid, foreign, future-dated, unidentified, incomplete and missing snapshots are not authority',
      withoutAuthority.every(([reason, projection]) => projection?.authority?.authority === 'none'
        && projection.authority.reason === reason
        && [501, 502, 503, 504].every((number) => unit(projection, number)?.observed === null
          && unit(projection, number)?.local === 'mark')
        && JSON.stringify(projection.humanWaits) === '[]')],
    ['an invalidated snapshot is dated history, never current',
      history?.authority?.authority === 'history' && history.authority.reason === 'INVALIDATED'
        && observed(history, 501) === JSON.stringify({ disposition: 'blocked', labels: ['human:decide', 'loop-blocked'], atMs: scanMs, current: false })
        && JSON.stringify(history.humanWaits) === '[]'],
    ['earlier-run units and record steps stay visible as last seen; only a card closes a unit',
      unit(visible, 530)?.local === 'earlier-run' && unit(visible, 530)?.round === '1/5'
        && unit(visible, 531)?.local === 'mark' && unit(visible, 531)?.step === '11-record'
        && unit(visible, 532) === null
        && JSON.stringify(visible.units.map((entry) => entry.issue)) === '[530,531,533]'],
    ['one entry per unit, and a blocked unit is not repeated as a human wait',
      JSON.stringify(duplicated?.units?.map((entry) => entry.issue)) === '[501,502,503,504,533]'
        && unit(duplicated, 501)?.lastSeenAtMs === at(11, 8, 0)
        && JSON.stringify(current.humanWaits) === '[510]'],
    ['legacy records stay readable; an undated step is qualified; malformed records are skipped',
      unit(legacy, 540)?.local === 'current' && unit(legacy, 540)?.attempt === 1
        && unit(legacy, 541)?.local === 'undated' && unit(legacy, 541)?.lastSeenAtMs === null
        && JSON.stringify(legacy?.units?.map((entry) => entry.issue)) === '[540,541]'],
    ['the projection mutates nothing it is given', current?.threw === undefined && newer?.threw === undefined
      && history?.threw === undefined && legacy?.threw === undefined && Object.isFrozen(snapshot)
      && verifySnapshot(snapshot)],
    ['the delivered caption follows the validated merge policy and is neutral when unknown',
      JSON.stringify(safely(() => ['manual', 'auto', 'ratified', null, 'sometimes', 'constructor', undefined].map(mergeCaption)))
        === JSON.stringify(['awaits human merge', 'automatic merge pending', 'ratified merge decision pending',
          'merge disposition pending', 'merge disposition pending', 'merge disposition pending', 'merge disposition pending'])],
    ['a pending delivery stays visible through its record step with its PR, policy and reason; a terminal card ends it',
      JSON.stringify(unit(delivered, 612)?.pending)
        === JSON.stringify({ pr: 700, policy: 'auto', reason: 'checks pending', atMs: at(12, 9, 45), observedAtMs: null })
        && unit(delivered, 612)?.step === '11-record' && unit(delivered, 612)?.local === 'mark'
        && unit(delivered, 613)?.pending?.policy === 'manual' && unit(delivered, 613)?.local === 'mark'
        && unit(delivered, 613)?.lastSeenAtMs === at(12, 9, 30)
        && unit(delivered, 614) === null
        && unit(delivered, 615)?.pending === null && unit(delivered, 615)?.local === 'current'],
    ['a legacy delivered card is pending only while a later scan positively observes its open PR',
      JSON.stringify(unit(legacyDeliveries[0], 640)?.pending)
        === JSON.stringify({ pr: 740, policy: null, reason: null, atMs: at(12, 9, 30), observedAtMs: scanMs })
        && unit(legacyDeliveries[0], 640)?.step === '09-gate' && unit(legacyDeliveries[0], 641) === null
        && legacyDeliveries.slice(1).every((projection) => projection?.threw === undefined
          && unit(projection, 640) === null)],
    ['an attempt counts entries of the current step, not repeats',
      safely(() => stepAttempt([{ step: '02-plan' }, { step: '03-plan-review' }, { step: '02-plan' }, { step: '02-plan' }])) === 2
        && safely(() => stepAttempt([{ step: '07-diff-review' }])) === 1],
  ];
  const failures = checks.filter(([, ok]) => !ok);
  for (const [name] of failures) console.error(`FAIL ${name}`);
  console.log(failures.length === 0
    ? `self-test OK (${checks.length} cases)`
    : `self-test FAILED (${failures.length}/${checks.length})`);
  return failures.length === 0;
}

const isMain = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] ?? '');
  } catch {
    return false;
  }
})();
if (isMain && process.argv.length === 3 && process.argv[2] === '--self-test') {
  process.exit(selfTest() ? 0 : 1);
}
