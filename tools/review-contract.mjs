#!/usr/bin/env node

// Code-review convergence: the authority for clean / continue / draft / block.
//
// Round 1 covers the complete artifact, rounds 2+ cover only the fix delta plus
// open rebuts, a verified Critical/Major outside a later delta earns a full
// round, and a rebut closes only when a fresh reviewer accepts that exact
// finding ID. A unit gets at most three fix rounds (SPEC-review-rounds): a
// Major still open after them is decided, re-planned once, or deferred, and a
// Major surviving the re-plan round hands the unit off as a draft. A verified
// Critical is fixed at any round and blocks when it survives the re-plan.
//
// What changed is the shape of the evidence. It used to be a chain of
// broker-signed runtime receipts whose authenticity came from an in-process
// signing key; the orchestrator could not construct one from a shell, which is
// how the loop stopped converging. It is now the record of the dispatches that
// actually happened: one entry per round, each naming its own dispatch, its
// writer and reviewer identities, the delta it reviewed, and the typed verdict
// `dispatch.mjs` parsed. Freshness is proved structurally — distinct dispatch
// ids per round, and a reviewer identity that is never the author's.
//
// Usage:
//   node <plugin-tools>/review-contract.mjs < review-input.json
//   node <plugin-tools>/review-contract.mjs --self-test

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotExecutionCheckout } from './checkout-contract.mjs';
import { currentProjectConfig, NO_CONFIG, resolveProjectConfig, reviewedConfig } from './config-contract.mjs';
import { boundaryEntryProblem, validReviewVerdict } from './dispatch.mjs';
import { inLane, widenLane } from './lane-contract.mjs';
import { sameModel } from './models-config.mjs';

const GATING_SEVERITIES = new Set(['Critical', 'Major']);
const REVIEW_SCOPES = new Map([
  ['full', 'full-artifact'],
  ['delta', 'fix-delta-and-open-rebuttals'],
]);
const HASH_RE = /^[0-9a-f]{64}$/;
const OID_RE = /^[0-9a-f]{40}$/;
const FINDING_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// A model id may carry a context-window suffix (`claude:gpt-6-astra[1m]`, as
// every configured id does since SPEC-model-config): refusing it failed a
// review chain at round 2, when the previous round is validated.
const IDENTITY_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,127}$/;
const DISPATCH_ID_RE = IDENTITY_RE;
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
// `widen` is a fix whose paths lie outside the plan boundary but inside the
// unit's seam (SPEC-elastic-scope): the ledger entry carries the added
// `paths`, and the evidence boundary grows by them. A `defer` may name the
// `seam` the path belongs to; such a finding is a repair at any round.
const DISPOSITIONS = new Set(['fix', 'rebut', 'defer', 'widen']);
// A Major the fixes keep missing is not worth another round of the same fix:
// after this many raisings it may be deferred to a filed follow-up issue, which
// the PR body lists, so the human still sees it at merge. A Critical never is.
const DEFER_AFTER_RAISINGS = 3;
// SPEC-review-rounds: round 1 plus this many fix rounds. On one project 12
// units reached a 20-round cap; rounds after the third did not converge, and
// late Majors were raised on lines earlier fixes added. A Major still open
// once the budget is spent is a decision (a rebut naming its decision
// comment), one re-plan round, or a deferral — never a fourth fix. A Critical
// is fixed regardless.
export const FIX_ROUND_BUDGET = 3;
const FOLLOW_UP_RE = /#[1-9][0-9]*/u;
const DECISION_LINK_RE = /#issuecomment-[1-9][0-9]*/u;
const LEDGER_STATES = new Set(['open', 'closed']);

const ROUND_KEYS = [
  'round',
  'scope',
  'dispatchId',
  'authorIdentity',
  'reviewerIdentity',
  'planFingerprint',
  'repositoryFingerprint',
  'configFingerprint',
  'configuredBaseOid',
  'deltaBaseOid',
  'headOid',
  'artifactVersion',
  'artifactFingerprint',
  'checkout',
  'priorFindings',
  'openRebuttals',
  'verdict',
];
const CHECKOUT_KEYS = [
  'root',
  'repositoryFingerprint',
  'branch',
  'headOid',
  'clean',
];
const LEDGER_KEYS = [
  'findingId',
  'severity',
  'summary',
  'evidence',
  'disposition',
  'state',
  'rationale',
];
// The predicate (rule, function) a finding is about. A Major re-raised,
// reworded or re-filed under a new id on the same predicate is the same
// finding: its raisings count under the predicate. Optional, so evidence
// recorded before 0.69.0 still validates; absent, the finding id is the key.
const LEDGER_OPTIONAL_KEYS = ['predicate', 'paths', 'seam'];
const ROUND_OPTIONAL_KEYS = ['deltaPaths', 'reworkAuthorization'];
// What reopens a unit after the re-plan hand-off (SPEC-review-rounds §5a): a
// human's `/answer rework`, or the one rework the loop decides. It names the
// hand-off round and that round's exact evidence; publish-verdict checks the
// comment on GitHub before it posts the review status.
const REWORK_KEYS = ['kind', 'issue', 'comment', 'round', 'evidenceFingerprint'];
const REWORK_KINDS = new Set(['answer', 'decision']);
const SCOPE_CHANGE_KEYS = ['findingId', 'paths', 'rationale'];
const MAX_BOUNDARY_ENTRIES = 1000;
const REBUTTAL_KEYS = ['findingId', 'claim', 'evidence'];

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, keys) {
  return isPlainObject(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function hasKeys(value, required, optional) {
  return isPlainObject(value)
    && required.every((key) => key in value)
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function validPredicate(value) {
  return value === undefined || boundedText(value, 1, 256);
}

function validBoundary(value, maximum = MAX_BOUNDARY_ENTRIES) {
  return Array.isArray(value)
    && value.length <= maximum
    && new Set(value).size === value.length
    && value.every((entry) => boundaryEntryProblem(entry) === null);
}

function validScopeChanges(value, boundary) {
  return Array.isArray(value)
    && value.length <= 100
    && value.every((change) =>
      hasExactKeys(change, SCOPE_CHANGE_KEYS)
      && FINDING_ID_RE.test(change.findingId)
      && validBoundary(change.paths, 100)
      && change.paths.length >= 1
      && change.paths.every((path) => inLane(path, boundary))
      && boundedText(change.rationale, 1, 4096));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function hashValue(value) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function sameSet(left, right) {
  return left.length === right.length
    && new Set(left).size === left.length
    && left.every((value) => right.includes(value));
}

function decision(state, code, detail = {}) {
  return {
    state,
    code,
    publishReviewSuccess: state === 'clean',
    ...detail,
  };
}

function boundedText(value, minimum, maximum) {
  return typeof value === 'string'
    && value.length >= minimum
    && value.length <= maximum;
}

function validExpected(expected) {
  return hasExactKeys(expected, [
    'planFingerprint',
    'repositoryFingerprint',
    'configuredBaseOid',
    'artifactVersion',
    'artifactFingerprint',
    'headOid',
  ])
    && HASH_RE.test(expected.planFingerprint)
    && HASH_RE.test(expected.repositoryFingerprint)
    && OID_RE.test(expected.configuredBaseOid)
    && Number.isSafeInteger(expected.artifactVersion)
    && expected.artifactVersion >= 1
    && HASH_RE.test(expected.artifactFingerprint)
    && OID_RE.test(expected.headOid);
}

function validAnnotations(annotations) {
  return Array.isArray(annotations)
    && annotations.length <= 100
    && new Set(annotations.map((annotation) => annotation?.id)).size
      === annotations.length
    && annotations.every((annotation) =>
      hasKeys(annotation, ['id', 'verified', 'inScope'], LEDGER_OPTIONAL_KEYS)
      && FINDING_ID_RE.test(annotation.id)
      && typeof annotation.verified === 'boolean'
      && typeof annotation.inScope === 'boolean'
      && validPredicate(annotation.predicate));
}

function validCheckout(checkout) {
  return hasExactKeys(checkout, CHECKOUT_KEYS)
    && boundedText(checkout.root, 2, 4096)
    && HASH_RE.test(checkout.repositoryFingerprint)
    && boundedText(checkout.branch, 1, 255)
    && OID_RE.test(checkout.headOid)
    && typeof checkout.clean === 'boolean';
}

function validLedgerEntry(entry) {
  return hasKeys(entry, LEDGER_KEYS, LEDGER_OPTIONAL_KEYS)
    && validPredicate(entry.predicate)
    && FINDING_ID_RE.test(entry.findingId)
    && GATING_SEVERITIES.has(entry.severity)
    && boundedText(entry.summary, 1, 4096)
    && boundedText(entry.evidence, 0, 16384)
    && DISPOSITIONS.has(entry.disposition)
    && LEDGER_STATES.has(entry.state)
    && boundedText(entry.rationale, 1, 4096)
    && (entry.disposition !== 'defer'
      || (entry.severity === 'Major' && FOLLOW_UP_RE.test(entry.rationale)))
    && (entry.seam === undefined
      || (entry.disposition === 'defer' && boundedText(entry.seam, 1, 1024)))
    && (entry.disposition === 'widen'
      ? validBoundary(entry.paths, 100) && entry.paths.length >= 1
      : entry.paths === undefined);
}

function validRebuttal(rebuttal) {
  return hasExactKeys(rebuttal, REBUTTAL_KEYS)
    && FINDING_ID_RE.test(rebuttal.findingId)
    && boundedText(rebuttal.claim, 1, 4096)
    && boundedText(rebuttal.evidence, 1, 16384);
}

// One recorded round. `dispatchId` is the identity of the reviewer process that
// produced the verdict — distinct per round is what "fresh reviewer" means once
// there is no broker to seal an execution instance.
// `<engine>:<model>`, compared as the same model however it is spelled (the
// dispatch stamps `[1m]`, a hand-written --author may not); anything else,
// exactly.
function sameIdentity(left, right) {
  const split = (identity) => {
    const at = String(identity ?? '').indexOf(':');
    return at === -1 ? null : [identity.slice(0, at), identity.slice(at + 1)];
  };
  const [a, b] = [split(left), split(right)];
  if (a === null || b === null) return left === right;
  return a[0] === b[0] && sameModel(a[1], b[1]);
}

function validReworkAuthorization(grant) {
  return hasExactKeys(grant, REWORK_KEYS)
    && REWORK_KINDS.has(grant.kind)
    && Number.isSafeInteger(grant.issue)
    && grant.issue >= 1
    && boundedText(grant.comment, 1, 512)
    && /^https:\/\/\S+$/u.test(grant.comment)
    && DECISION_LINK_RE.test(grant.comment)
    && Number.isSafeInteger(grant.round)
    && grant.round >= 1
    && grant.round <= 100
    && HASH_RE.test(grant.evidenceFingerprint);
}

export function validReviewRound(record) {
  return hasKeys(record, ROUND_KEYS, ROUND_OPTIONAL_KEYS)
    && (record.deltaPaths === undefined || validBoundary(record.deltaPaths, 10000))
    && (record.reworkAuthorization === undefined || validReworkAuthorization(record.reworkAuthorization))
    && Number.isSafeInteger(record.round)
    && record.round >= 1
    && record.round <= 100
    && [...REVIEW_SCOPES.values()].includes(record.scope)
    && boundedText(record.dispatchId, 1, 128)
    && IDENTITY_RE.test(record.dispatchId)
    && IDENTITY_RE.test(record.authorIdentity ?? '')
    && IDENTITY_RE.test(record.reviewerIdentity ?? '')
    // Writer and reviewer identities never collide. Under the broker this was
    // a sealed actor fingerprint; here it is the plain statement, and it is
    // still the invariant that makes an independent review independent.
    && !sameIdentity(record.authorIdentity, record.reviewerIdentity)
    && HASH_RE.test(record.planFingerprint)
    && HASH_RE.test(record.repositoryFingerprint)
    && HASH_RE.test(record.configFingerprint)
    && OID_RE.test(record.configuredBaseOid)
    && OID_RE.test(record.deltaBaseOid)
    && OID_RE.test(record.headOid)
    && Number.isSafeInteger(record.artifactVersion)
    && record.artifactVersion >= 1
    && HASH_RE.test(record.artifactFingerprint)
    && validCheckout(record.checkout)
    && record.checkout.repositoryFingerprint === record.repositoryFingerprint
    && record.checkout.headOid === record.headOid
    && Array.isArray(record.priorFindings)
    && record.priorFindings.length <= 100
    && new Set(record.priorFindings.map(({ findingId }) => findingId)).size
      === record.priorFindings.length
    && record.priorFindings.every(validLedgerEntry)
    && Array.isArray(record.openRebuttals)
    && record.openRebuttals.length <= 100
    && new Set(record.openRebuttals.map(({ findingId }) => findingId)).size
      === record.openRebuttals.length
    && record.openRebuttals.every(validRebuttal)
    && validReviewVerdict(record.verdict);
}

function gatingFindings(verdict) {
  return verdict.findings.filter(({ severity }) =>
    GATING_SEVERITIES.has(severity));
}

// A finding is its id and its severity. Severity is the field that gates, so
// pinning it is what stops a Critical being carried forward as a Minor; the
// summary and evidence are prose, and they belong to whichever reviewer wrote
// them. Requiring those to stay byte-identical across rounds sounded like
// authentication and was really a demand that a second reviewer repeat the
// first one's words — see `authenticatedFindings`.
function findingCoreMatches(ledgerFinding, finding) {
  return ledgerFinding.findingId === finding.id
    && ledgerFinding.severity === finding.severity;
}

function verdictMatchesOpenRebuts(record) {
  const openIds = record.openRebuttals.map(({ findingId }) => findingId);
  const rebutIds = record.verdict.rebuts.map(({ findingId }) => findingId);
  const gatingIds = new Set(gatingFindings(record.verdict).map(({ id }) => id));
  return sameSet(openIds, rebutIds)
    && record.verdict.rebuts.every(({ findingId, status }) =>
      status === 'accepted'
        ? !gatingIds.has(findingId)
        : gatingIds.has(findingId));
}

function validCumulativeLedger(previous, current) {
  const previousVerdict = previous.verdict;
  const previousGating = new Map(
    gatingFindings(previousVerdict).map((finding) => [finding.id, finding]),
  );
  const previousRebuts = new Map(
    previousVerdict.rebuts.map((rebut) => [rebut.findingId, rebut]),
  );
  const priorLedger = new Map(
    previous.priorFindings.map((finding) => [finding.findingId, finding]),
  );
  const currentLedger = new Map(
    current.priorFindings.map((finding) => [finding.findingId, finding]),
  );
  const expectedIds = new Set([
    ...priorLedger.keys(),
    ...previousGating.keys(),
  ]);
  if (
    currentLedger.size !== expectedIds.size
    || [...expectedIds].some((id) => !currentLedger.has(id))
  ) {
    return false;
  }
  for (const [id, currentFinding] of currentLedger) {
    const previousFinding = priorLedger.get(id);
    const repeated = previousGating.get(id);
    if (repeated) {
      if (
        !findingCoreMatches(currentFinding, repeated)
        || currentFinding.state !== 'open'
      ) {
        return false;
      }
      if (previousFinding && !findingCoreMatches(previousFinding, repeated)) {
        return false;
      }
      continue;
    }
    if (!previousFinding) return false;
    const expectedState = ledgerEntryCloses(previousFinding, previousRebuts) ? 'closed' : null;
    if (
      expectedState === null
      || hashValue(currentFinding)
        !== hashValue({ ...previousFinding, state: expectedState })
    ) {
      return false;
    }
  }
  return true;
}

function openEntries(record, disposition) {
  return record.priorFindings.filter((entry) =>
    entry.state === 'open' && entry.disposition === disposition);
}

// The open entries a round fixes: a `fix` or a `widen` disposition.
function openFixes(record) {
  return [...openEntries(record, 'fix'), ...openEntries(record, 'widen')];
}

// The findings a round's ledger defers: a deferral stands until the unit closes.
function deferredIn(record) {
  return new Set(record.priorFindings
    .filter(({ disposition }) => disposition === 'defer').map(({ findingId }) => findingId));
}

// SPEC-review-rounds §5: after the re-plan a Major is deferred outside the seam
// (the deferral names it) or decided (the rebuttal names the decision comment),
// never deferred or rebutted bare — the fix budget no longer excuses either. A
// deferral standing from the round before carries as it stands.
function boundedDispositions(record, previous) {
  const standing = deferredIn(previous);
  return openEntries(record, 'defer').every(({ findingId, seam }) => seam !== undefined || standing.has(findingId))
    && openEntries(record, 'rebut').every(({ rationale }) => DECISION_LINK_RE.test(rationale));
}

// Convergence closes on a full-artifact round, and the closing round may be a
// re-read of bytes a delta round already saw. That round is distinguished by
// its SCOPE, not by its content: it reviews the whole of the same artifact.
// Without this the rule deadlocks — the moment a delta round comes back clean,
// the mandated full round has nothing new to fingerprint and the chain refuses
// it as "nothing was re-reviewed". A live run hit exactly that, ran the closing
// round anyway, and could not record it. A round that fixed nothing — every
// open finding rebutted (a decision) or deferred — is the same case: the
// artifact did not change, so the round is full over the same bytes.
function sameArtifactRound(previous, current) {
  return isPlainObject(previous)
    && isPlainObject(current)
    && current.scope === REVIEW_SCOPES.get('full')
    && current.artifactFingerprint === previous.artifactFingerprint
    && current.artifactVersion === previous.artifactVersion
    && current.headOid === previous.headOid
    && openEntries(current, 'fix').length === 0
    && openEntries(current, 'widen').length === 0;
}

// A prior ledger entry leaves the gating set once it is closed, fixed,
// deferred, or rebutted with the rebuttal accepted.
function ledgerEntryCloses(entry, rebutsById) {
  return entry.state === 'closed'
    || entry.disposition === 'fix'
    || entry.disposition === 'widen'
    || entry.disposition === 'defer'
    || rebutsById.get(entry.findingId)?.status === 'accepted';
}

// SPEC-elastic-scope: the delta round after a widening reviews the added
// paths. A delta whose changed paths miss one did not see the fix it records.
function widenCoverage(rounds, gaps = []) {
  for (const record of rounds) {
    if (record.scope !== REVIEW_SCOPES.get('delta')) continue;
    const delta = record.deltaPaths ?? [];
    for (const entry of openEntries(record, 'widen')) {
      const missed = entry.paths.find((path) => !delta.some((changed) => inLane(changed, [path])));
      if (missed !== undefined) {
        gaps.push(
          `round ${record.round}: finding ${entry.findingId} widened the boundary by `
          + `${missed} but the delta reviewed does not change it — review the widened `
          + 'paths in this round, or make it a full round',
        );
        return { code: 'REVIEW_DELTA_SCOPE_INCOMPLETE' };
      }
    }
  }
  return { code: null };
}

// Fingerprints and OIDs are unreadable at full length in a one-line gap, and a
// gap nobody reads is the bare code again.
function brief(value) {
  return typeof value === 'string' && /^[0-9a-f]{40,64}$/u.test(value)
    ? `${value.slice(0, 12)}…`
    : String(value);
}

// EVERY refusal here names itself. A single undifferentiated null cost one live
// run a bisect and another most of a day: the caller's one
// INVALID_REVIEW_EVIDENCE code cannot say which chain rule broke, and the rules
// that bit hardest — `artifactVersion`, and a top-level `scope` that disagrees
// with the closing round's own — are stated nowhere the orchestrator reads.
function roundHistory(rounds, round, scope, expected, projectConfig, gaps = []) {
  if (!Array.isArray(rounds) || rounds.length !== round) {
    gaps.push(
      `reviewRounds must hold exactly ${round} record(s), one per round `
      + `(got ${Array.isArray(rounds) ? rounds.length : typeof rounds})`,
    );
    return null;
  }
  const malformed = rounds.findIndex((record) => !validReviewRound(record));
  if (malformed !== -1) {
    gaps.push(
      `round ${malformed + 1}: the record is not a valid review round — check `
      + 'its key set, hashes, oids, ledger entries and verdict shape',
    );
    return null;
  }
  const first = rounds[0];
  // The plan is not here: a re-plan round records its new plan fingerprint
  // (`roundBudget` allows that once).
  const stable = [
    'repositoryFingerprint',
    'configFingerprint',
    'configuredBaseOid',
    'authorIdentity',
  ];
  for (const [index, record] of rounds.entries()) {
    const at = `round ${index + 1}`;
    if (record.round !== index + 1) {
      gaps.push(`${at}: the record numbers itself ${record.round}`);
      return null;
    }
    if (index === 0 && record.scope !== REVIEW_SCOPES.get('full')) {
      gaps.push(`${at}: round 1 is always the complete artifact`);
      return null;
    }
    const drifted = stable.find((key) => record[key] !== first[key]);
    if (drifted !== undefined) {
      gaps.push(
        `${at}: ${drifted} is ${brief(record[drifted])} but round 1 recorded `
        + `${brief(first[drifted])} — it may not change across a review chain`,
      );
      return null;
    }
    if (
      record.checkout.root !== first.checkout.root
      || record.checkout.branch !== first.checkout.branch
    ) {
      gaps.push(`${at}: the reviewed checkout moved root or branch`);
      return null;
    }
    if (!verdictMatchesOpenRebuts(record)) {
      gaps.push(
        `${at}: openRebuttals and the verdict's rebuts are not the same set, `
        + 'or a rebut status disagrees with whether the finding still gates',
      );
      return null;
    }
  }
  // A repeated dispatch id is a replayed reviewer, not a fresh one.
  if (new Set(rounds.map(({ dispatchId }) => dispatchId)).size !== rounds.length) {
    gaps.push('dispatchId must be distinct per round — a repeat is a replayed reviewer');
    return null;
  }
  if (first.configFingerprint !== hashValue(projectConfig)) {
    gaps.push(
      `round 1: configFingerprint is ${brief(first.configFingerprint)} but the `
      + `supplied projectConfig hashes to ${brief(hashValue(projectConfig))} — `
      + 'canonical is `jq -S -c -j`, keys sorted, compact, no trailing newline',
    );
    return null;
  }
  if (first.deltaBaseOid !== first.configuredBaseOid) {
    gaps.push('round 1: deltaBaseOid must equal the configured base');
    return null;
  }
  for (let index = 1; index < rounds.length; index += 1) {
    const previous = rounds[index - 1];
    const current = rounds[index];
    if (current.deltaBaseOid !== previous.headOid) {
      gaps.push(`round ${index + 1}: deltaBaseOid must equal the previous round's headOid`);
      return null;
    }
    if (!validCumulativeLedger(previous, current)) {
      gaps.push(`round ${index + 1}: the cumulative finding ledger is not carried forward`);
      return null;
    }
    if (sameArtifactRound(previous, current)) continue;
    if (current.artifactVersion <= previous.artifactVersion) {
      gaps.push(
        `round ${index + 1}: artifactVersion must strictly increase per round `
        + `(got ${current.artifactVersion} after ${previous.artifactVersion}) — it versions the `
        + 'reviewed artifact, not the plan',
      );
      return null;
    }
    if (current.artifactFingerprint === previous.artifactFingerprint) {
      gaps.push(
        `round ${index + 1}: artifactFingerprint is unchanged — nothing was `
        + 're-reviewed. A full-artifact round over an unchanged artifact '
        + '(a closing round, or one that rebuts or defers every open finding) '
        + 'must also carry the previous round\'s artifactVersion and headOid',
      );
      return null;
    }
  }
  const current = rounds.at(-1);
  const declared = [
    ['scope', current.scope, REVIEW_SCOPES.get(scope)],
    ['planFingerprint', current.planFingerprint, expected.planFingerprint],
    ['repositoryFingerprint', current.repositoryFingerprint, expected.repositoryFingerprint],
    ['configuredBaseOid', current.configuredBaseOid, expected.configuredBaseOid],
    ['artifactVersion', current.artifactVersion, expected.artifactVersion],
    ['artifactFingerprint', current.artifactFingerprint, expected.artifactFingerprint],
    ['headOid', current.headOid, expected.headOid],
  ].find(([, recorded, wanted]) => recorded !== wanted);
  if (declared !== undefined) {
    gaps.push(
      `round ${rounds.length}: the closing round records ${declared[0]} `
      + `${brief(declared[1])} but the transition declares ${brief(declared[2])}`,
    );
    return null;
  }
  return { current, rounds };
}

// Re-raising a finding id keeps its severity. It does NOT keep its prose: a
// later reviewer re-raises precisely to say why the fix fell short, and saying
// that is rewriting the summary and the evidence.
//
// The rule used to demand all three, and living-football-engine #313 hit the
// consequence exactly: rounds 1 and 2 both raised two Majors, round 2 rewording
// each to explain what the fix missed, and the chain became unauthenticatable
// at every head. The check runs ahead of the ledger, so no construction
// satisfied it — the only input that would have was one with the reviewers'
// recorded verdicts rewritten to agree, which is fabricated evidence. That unit
// still has no `agentic/review` status and no run can ever give it one.
function authenticatedFindings(rounds, gaps = []) {
  const history = new Map();
  for (const record of rounds) {
    for (const finding of record.verdict.findings) {
      const previous = history.get(finding.id);
      if (previous && previous.severity !== finding.severity) {
        gaps.push(
          `round ${record.round}: finding ${finding.id} re-raised as `
          + `${finding.severity} after ${previous.severity} — a finding id is `
          + 'immutable; anything reassessed is a new finding with a new id',
        );
        return null;
      }
      if (!previous) history.set(finding.id, finding);
    }
  }
  return history;
}

// Round 1's projectConfig must equal prime's, which comes from the resolver:
// `--state` names the base checkout's `.autoloop/config.json` exactly, and the
// repository root (two levels up) is derived from it. Anything else —
// `.autoloop/STATE.md` is prose — would derive a wrong root.
export function projectConfigForReview(path) {
  const segments = resolve(String(path)).split(sep);
  const tail = (count) => segments.slice(-count).join('/');
  let root;
  if (String(path) !== '' && tail(2) === '.autoloop/config.json') root = resolve(path, '..', '..');
  else throw new Error('--state must name <base>/.autoloop/config.json');
  const resolved = resolveProjectConfig(root);
  if (!resolved?.ok) throw new Error(`project config: ${resolved?.errors?.join('; ') ?? NO_CONFIG}`);
  // As prime hands it over: the step model table is not reviewed policy.
  return reviewedConfig(resolved.config);
}

// A finding's predicate: the one its ledger entry or its annotation names,
// else its id. Both the ledger and the closing round's annotations are read,
// because the closing round's own findings have no ledger entry yet.
function predicateIndex(rounds, annotations) {
  const index = new Map();
  for (const record of rounds) {
    for (const entry of record.priorFindings) {
      if (entry.predicate !== undefined) index.set(entry.findingId, entry.predicate);
    }
  }
  for (const annotation of annotations) {
    if (annotation.predicate !== undefined) index.set(annotation.id, annotation.predicate);
  }
  return (id) => index.get(id) ?? id;
}

// How many of the given rounds raised the predicate, under any id.
function raisingsOf(rounds, predicate, predicateOf) {
  return rounds.filter(({ verdict }) =>
    verdict.findings.some(({ id }) => predicateOf(id) === predicate)).length;
}

// Which round is which, read from the record: a round whose plan fingerprint
// differs from the one before it is the re-plan round; a round with an open
// `fix` disposition is a fix round; any other round rebuts or defers over the
// same artifact. The refusals name themselves: REVIEW_FIX_BUDGET_SPENT for a
// fourth fix round, or a second decision on a predicate a fresh reviewer
// already rejected; REVIEW_REPLAN_SPENT for a round past the re-plan round's
// one admitted round (and its closing round after a Critical fix);
// REVIEW_REWORK_SPENT for a rework its hand-off does not admit.
//
// SPEC-review-rounds §5a: the round a rework names is a hand-off after the
// re-plan — a gating finding open, not the re-plan round's own Critical,
// which is still fixed — and this round is the one fix round after it, or
// the closing full round over the same plan.
function reworkAdmitted(rounds, index, replanRound, grant) {
  if (replanRound === null) return false;
  const from = rounds.findIndex(({ round }) => round === grant.round);
  if (from === -1 || from >= index || hashValue(rounds[from]) !== grant.evidenceFingerprint) return false;
  // A re-raised deferral gates nothing (reviewTransition), so it hands nothing off.
  const deferred = deferredIn(rounds[from]);
  const gating = gatingFindings(rounds[from].verdict).filter(({ id }) => !deferred.has(id));
  const handoff = gating.length > 0
    && (from > replanRound || gating.every(({ severity }) => severity !== 'Critical'));
  const current = rounds[index];
  if (!handoff || current.planFingerprint !== rounds[index - 1].planFingerprint || !boundedDispositions(current, rounds[index - 1])) return false;
  if (index === from + 1) return true;
  return index === from + 2 && openFixes(current).length === 0 && current.scope === REVIEW_SCOPES.get('full')
    && hashValue(rounds[from + 1].reworkAuthorization ?? {}) === hashValue(grant);
}

function roundBudget(rounds, predicateOf, gaps = []) {
  let fixRounds = 0;
  let replanRound = null;
  let postReplanFix = false;
  const decided = new Set();
  const rejected = new Set();
  const decidedReworks = new Set();
  if (rounds[0].reworkAuthorization !== undefined) {
    gaps.push('round 1: a rework follows the re-plan hand-off');
    return { code: 'REVIEW_REWORK_SPENT' };
  }
  for (let index = 1; index < rounds.length; index += 1) {
    const previous = rounds[index - 1];
    const current = rounds[index];
    const at = `round ${current.round}`;
    for (const rebut of previous.verdict.rebuts) {
      const predicate = predicateOf(rebut.findingId);
      if (rebut.status === 'rejected' && decided.has(predicate)) rejected.add(predicate);
    }
    const grant = current.reworkAuthorization;
    if (grant !== undefined) {
      if (grant.kind === 'decision') decidedReworks.add(grant.evidenceFingerprint);
      if (decidedReworks.size > 1 || !reworkAdmitted(rounds, index, replanRound, grant)) {
        gaps.push(
          `${at}: a rework admits one fix round, then the closing full round, after the re-plan `
          + `hand-off it names (round ${grant.round}, its exact evidence); the loop decides one `
          + 'rework per unit, a human answers any other',
        );
        return { code: 'REVIEW_REWORK_SPENT' };
      }
      continue;
    }
    if (replanRound !== null) {
      // SPEC-review-rounds §5: a finding first seen in the re-plan round still
      // gets one round — fixing only Criticals, or deferring (naming the seam)
      // and deciding (naming the decision comment) Majors — then the closing
      // full round after a Critical fix. Nothing else follows the re-plan.
      const fixes = openFixes(current);
      const admitted = current.planFingerprint === previous.planFingerprint && boundedDispositions(current, previous) && (
        index === replanRound + 1
          ? fixes.every(({ severity }) => severity === 'Critical')
          : index === replanRound + 2 && postReplanFix && fixes.length === 0
            && current.scope === REVIEW_SCOPES.get('full'));
      if (!admitted) {
        gaps.push(
          `${at}: round ${rounds[replanRound].round} re-planned the unit; one round after it may `
          + 'fix a Critical, defer a Major outside the seam or decide one, then the closing full '
          + 'round — a Major still open hands the unit off as a draft, a Critical blocks',
        );
        return { code: 'REVIEW_REPLAN_SPENT' };
      }
      if (index === replanRound + 1 && fixes.length > 0) postReplanFix = true;
      continue;
    }
    if (current.planFingerprint !== previous.planFingerprint) {
      if (current.scope !== REVIEW_SCOPES.get('full')) {
        gaps.push(`${at}: the re-plan round reviews the complete artifact (scope full)`);
        return { code: 'INVALID_REVIEW_EVIDENCE' };
      }
      replanRound = index;
      continue;
    }
    const spent = fixRounds >= FIX_ROUND_BUDGET;
    const fixes = openFixes(current);
    if (fixes.length > 0) {
      if (spent && !fixes.some(({ severity }) => severity === 'Critical')) {
        gaps.push(
          `${at}: the budget of ${FIX_ROUND_BUDGET} fix rounds is spent — decide (rebut `
          + 'naming the decision comment), re-plan once, or defer each open Major',
        );
        return { code: 'REVIEW_FIX_BUDGET_SPENT' };
      }
      fixRounds += 1;
    }
    if (!spent) continue;
    for (const entry of openEntries(current, 'rebut')) {
      const predicate = predicateOf(entry.findingId);
      if (!DECISION_LINK_RE.test(entry.rationale)) {
        gaps.push(
          `${at}: after the fix budget a rebuttal of ${entry.findingId} is a decision — `
          + 'record it with unit.mjs --decide and name the decision comment '
          + '(…#issuecomment-N) in the rationale',
        );
        return { code: 'INVALID_REVIEW_EVIDENCE' };
      }
      if (rejected.has(predicate)) {
        gaps.push(
          `${at}: a fresh reviewer rejected the decision on ${entry.findingId}; `
          + 're-plan once or defer it',
        );
        return { code: 'REVIEW_FIX_BUDGET_SPENT' };
      }
      decided.add(predicate);
    }
  }
  return { code: null, fixRounds, replanRound, afterReplan: replanRound !== null && replanRound < rounds.length - 1 };
}

export function reviewTransition(input) {
  if (
    !hasKeys(input, [
      'round',
      'scope',
      'projectConfig',
      'expected',
      'findingAnnotations',
      'reviewRounds',
    ], ['boundary', 'scopeChanges'])
    // The unit's boundary (the plan's, widened) and the record of each
    // widening; evidence recorded before 0.69.0 carries neither.
    || (input.boundary !== undefined && !validBoundary(input.boundary))
    || (input.scopeChanges !== undefined
      && !validScopeChanges(input.scopeChanges, input.boundary ?? []))
    || !Number.isSafeInteger(input.round)
    || input.round < 1
    || !REVIEW_SCOPES.has(input.scope)
    // Round 1 is always the complete artifact. Later rounds are delta while
    // fixes churn — and FULL when closing: 0.46.0 made "convergence closes on
    // a full-artifact round" the rule, and this line kept refusing it, so the
    // optimistic close was prose a live session could not execute.
    || (input.round === 1 && input.scope !== 'full')
    // A chain started before setup migrated STATE keeps its config (every
    // round's fingerprint binds it); valid at a migratable schema is enough.
    || !currentProjectConfig(input.projectConfig).ok
    || !validExpected(input.expected)
    || !validAnnotations(input.findingAnnotations)
  ) {
    return decision('error', 'INVALID_REVIEW_INPUT');
  }

  const evidenceGaps = [];
  const history = roundHistory(
    input.reviewRounds,
    input.round,
    input.scope,
    input.expected,
    input.projectConfig,
    evidenceGaps,
  );
  if (!history) {
    return decision('error', 'INVALID_REVIEW_EVIDENCE', evidenceGaps.length > 0
      ? { evidenceGap: evidenceGaps[0] }
      : {});
  }
  if (!authenticatedFindings(history.rounds, evidenceGaps)) {
    return decision('error', 'INVALID_REVIEW_EVIDENCE', evidenceGaps.length > 0
      ? { evidenceGap: evidenceGaps[0] }
      : {});
  }
  const coverage = widenCoverage(history.rounds, evidenceGaps);
  if (coverage.code !== null) {
    return decision('error', coverage.code, { evidenceGap: evidenceGaps.at(-1) });
  }
  const predicateOf = predicateIndex(history.rounds, input.findingAnnotations);
  const budget = roundBudget(history.rounds, predicateOf, evidenceGaps);
  if (budget.code !== null) {
    return decision('error', budget.code, { evidenceGap: evidenceGaps.at(-1) });
  }
  const budgetSpent = budget.fixRounds >= FIX_ROUND_BUDGET;
  const fixRounds = { used: budget.fixRounds, budget: FIX_ROUND_BUDGET };

  const currentVerdict = history.current.verdict;
  const currentIds = currentVerdict.findings.map(({ id }) => id);
  const annotationIds = input.findingAnnotations.map(({ id }) => id);
  const rebutIds = history.current.openRebuttals.map(({ findingId }) => findingId);
  const authenticatedRebutIds = currentVerdict.rebuts.map(
    ({ findingId }) => findingId,
  );
  if (!sameSet(currentIds, annotationIds)) {
    return decision('error', 'INVALID_REVIEW_EVIDENCE', {
      evidenceGap: 'findingAnnotations must annotate exactly the closing '
        + `verdict's findings (verdict ${currentIds.length}, annotations `
        + `${annotationIds.length})`,
    });
  }
  if (!sameSet(rebutIds, authenticatedRebutIds)) {
    return decision('error', 'INVALID_REVIEW_EVIDENCE', {
      evidenceGap: "the closing round's openRebuttals and its verdict's rebuts "
        + 'must name the same findings',
    });
  }
  // A brief that invites the reviewer to "re-examine" a prior disposition gets
  // that agreement recorded as a rebut, and round 1 has nothing to rebut. One
  // live dispatch was spent, clean, and unpublishable.
  if (input.round === 1 && rebutIds.length > 0) {
    return decision('error', 'INVALID_REVIEW_EVIDENCE', {
      evidenceGap: 'round 1 has no prior round, so its verdict carries no '
        + 'rebuts — rebuts adjudicate open rebuttals from a preceding round',
    });
  }

  const deferred = history.current.priorFindings.filter(
    ({ disposition }) => disposition === 'defer',
  );
  // Once the fix budget is spent, deferral is one of the three ways out and
  // needs no third raising.
  for (const entry of deferred) {
    const raisings = raisingsOf(
      history.rounds.slice(0, -1), predicateOf(entry.findingId), predicateOf,
    );
    if (raisings < DEFER_AFTER_RAISINGS && !budgetSpent && entry.seam === undefined) {
      return decision('error', 'INVALID_REVIEW_EVIDENCE', {
        evidenceGap: `finding ${entry.findingId} is deferred after ${raisings} raising(s); `
          + `only a Major raised in ${DEFER_AFTER_RAISINGS} rounds, any Major once the fix `
          + 'budget is spent, or a Major outside the seam (the deferral names it) may be '
          + 'deferred — fix, widen or rebut it',
      });
    }
  }
  const deferredIds = new Set(deferred.map(({ findingId }) => findingId));
  // Each distinct rework in the ledger, once: the fix round and its closing
  // round carry the same one.
  const reworks = new Map();
  for (const { reworkAuthorization } of history.rounds) {
    if (reworkAuthorization !== undefined) reworks.set(hashValue(reworkAuthorization), structuredClone(reworkAuthorization));
  }
  // The evidence every publishable (clean) decision carries.
  const closedEvidence = () => ({
    ...(deferred.length === 0 ? {} : {
      deferredFindings: deferred.map(({ findingId, rationale }) => ({ findingId, rationale })),
    }),
    // Every widening, for `## Scope changes` in the PR body.
    ...((input.scopeChanges?.length ?? 0) === 0 ? {} : {
      scopeChanges: structuredClone(input.scopeChanges),
    }),
    // Each rework that reopened the unit, for publish-verdict to check on GitHub.
    ...(reworks.size === 0 ? {} : { reworkAuthorizations: [...reworks.values()] }),
    reviewedHead: history.current.headOid,
    reviewedCheckout: structuredClone(history.current.checkout),
    reviewEvidenceFingerprint: hashValue(history.current),
  });
  const annotations = new Map(
    input.findingAnnotations.map((annotation) => [annotation.id, annotation]),
  );
  // A deferred finding a later reviewer raises again no longer gates: it is
  // already filed, and re-raising it is the recurrence the deferral exists for.
  const currentGating = gatingFindings(currentVerdict)
    .filter(({ id }) => !deferredIds.has(id));
  const currentGatingIds = new Set(currentGating.map(({ id }) => id));
  const inconsistentRebut = currentVerdict.rebuts.find(({ findingId, status }) =>
    status === 'accepted'
      ? currentGatingIds.has(findingId)
      : !currentGatingIds.has(findingId));
  if (inconsistentRebut !== undefined) {
    return decision('error', 'INVALID_REVIEW_EVIDENCE', {
      evidenceGap: `rebut ${inconsistentRebut.findingId} is `
        + `${inconsistentRebut.status} but the same verdict `
        + `${inconsistentRebut.status === 'accepted' ? 'still raises' : 'no longer raises'}`
        + ' it as a gating finding',
    });
  }
  if (
    input.round === 1
    && input.findingAnnotations.some(({ inScope }) => inScope !== true)
  ) {
    return decision('error', 'INVALID_REVIEW_EVIDENCE', {
      evidenceGap: 'round 1 reviews the complete artifact, so no finding of '
        + 'its can be annotated out of scope',
    });
  }
  if (currentGating.some(({ id }) => annotations.get(id).verified !== true)) {
    return decision('verify', 'FINDING_VERIFICATION_REQUIRED');
  }

  const critical = currentGating.some(({ severity }) => severity === 'Critical');
  // After the re-plan no fix round follows to widen into: what still gates is
  // the hand-off below, never a full round the budget then refuses.
  const late = input.scope === 'delta' && !budget.afterReplan && (!budgetSpent || critical)
    ? currentGating.filter(({ id }) => annotations.get(id).inScope !== true)
    : [];
  // A real defect the delta could not see is a reason to look wider, not to
  // stop: fix it and review the whole artifact.
  if (late.length > 0) {
    return decision('continue', 'REVIEW_FULL_ROUND_REQUIRED', {
      findings: late.map(({ id, severity }) => ({ id, severity })),
    });
  }

  const rejectedRebuts = currentVerdict.rebuts.filter(
    ({ status }) => status === 'rejected',
  );
  if (currentGating.length === 0 && rejectedRebuts.length === 0) {
    // Convergence closes on a full-artifact round. A delta round sees the last
    // fix and nothing else, so the defect it structurally cannot see is the one
    // an earlier fix made vacuous. living-football-engine #314 ran rounds 2-5
    // all delta and closed on one; round 4 had already caught an assertion
    // killed two rounds before, which is that defect class exactly. The rule
    // was 0.46.0 prose and the contract accepted a delta close for ten
    // releases.
    if (input.scope !== 'full') {
      return decision('continue', 'REVIEW_FULL_CLOSE_REQUIRED', {
        reviewedHead: history.current.headOid,
      });
    }
    return decision('clean', 'REVIEW_CLEAN', closedEvidence());
  }
  // The ledger of what still gates, for the PR body or the block comment.
  const openFindings = currentGating.map(({ id, severity, summary, evidence }) => ({
    id,
    severity,
    predicate: predicateOf(id),
    raisings: raisingsOf(history.rounds, predicateOf(id), predicateOf),
    summary,
    evidence,
  }));
  const detail = {
    unresolvedFindings: currentGating.length,
    rejectedRebuts: rejectedRebuts.length,
    fixRounds,
  };
  // After the re-plan round a Critical gets one more fix round (the re-plan
  // was the first to see it); still open after that round, it is the human's
  // (POLICY_DENIED, the ledger in the block comment). A Major is filed as a
  // repair and the unit goes out as a draft with `## Open findings` and
  // `human:decide` — the one review path that waits for a human.
  if (budget.replanRound !== null && (budget.afterReplan || !critical)) {
    // The round and its evidence: a rework names both (SPEC-review-rounds §5a).
    const handoff = {
      ...detail,
      openFindings,
      reviewedHead: history.current.headOid,
      round: history.current.round,
      reviewEvidenceFingerprint: hashValue(history.current),
    };
    return critical
      ? decision('block', 'POLICY_DENIED', handoff)
      : decision('draft', 'REVIEW_OPEN_FINDINGS', handoff);
  }
  if (!budgetSpent || critical) {
    return decision('continue', 'REVIEW_FIX_DELTA_REQUIRED', detail);
  }
  // The fix budget is spent and only Majors remain: each is decided (a rebut
  // naming its decision comment, then one closing full round), re-planned
  // (once, every open finding in the plan brief), or deferred to a repair.
  return decision('continue', 'REVIEW_REPLAN', { ...detail, openFindings });
}

// The closing full-artifact round is the ONE round nobody can derive from the
// repository: it re-reads bytes already reviewed, so every field except its own
// number, scope, dispatch and verdict is inherited from the round before it.
// Until 0.49.57 an orchestrator assembled that by hand, and the live evidence
// of how that goes is five bespoke `assemble-evidence-<issue>.jq` programs on
// one run host, a unit that lost a debugging cycle to declaring the wrong
// top-level `scope`, and a session halted outright because a permission
// classifier — correctly — would not run an ad-hoc program that writes review
// verdicts into an audit artifact.
//
// So the tool does it. Nothing here is a judgement: the ledger carry-forward is
// `validCumulativeLedger`'s own rule read constructively, and the result is
// handed to `reviewTransition` before it is returned, so this can never emit
// evidence the contract would refuse.
function carriedLedger(previous) {
  const rebuts = new Map(
    previous.verdict.rebuts.map((rebut) => [rebut.findingId, rebut]),
  );
  const carried = [];
  for (const entry of previous.priorFindings) {
    if (!ledgerEntryCloses(entry, rebuts)) return null;
    carried.push({ ...entry, state: 'closed' });
  }
  return carried;
}

// An appended round is returned only when the contract accepts it.
function validatedAppend(appended) {
  const transition = reviewTransition(appended);
  if (transition.state === 'error') {
    return {
      ok: false,
      code: transition.code,
      reason: transition.evidenceGap ?? 'the appended round does not validate',
    };
  }
  return { ok: true, code: transition.code, evidence: appended };
}

export function appendEscalationRound(evidence, result, options = {}) {
  const refuse = (code, reason) => ({ ok: false, code, reason });
  const pending = reviewTransition(evidence);
  if (pending.code !== 'REVIEW_FULL_CLOSE_REQUIRED') {
    return refuse(
      'NOT_AWAITING_FULL_CLOSE',
      'the evidence is not a clean delta round awaiting its closing '
      + `full-artifact round (${pending.code}${pending.evidenceGap ? `: ${pending.evidenceGap}` : ''})`,
    );
  }
  const verdict = result?.verdict;
  if (result?.ok !== true || !validReviewVerdict(verdict)) {
    return refuse(
      'INVALID_DISPATCH_RESULT',
      'the dispatch result is not a successful review with a valid verdict',
    );
  }
  if (verdict.rebuts.length > 0) {
    return refuse(
      'ESCALATION_ROUND_CANNOT_REBUT',
      'the preceding round closed clean, so no rebuttal is open for this round '
      + 'to adjudicate — a verdict carrying rebuts here reviewed something else',
    );
  }
  const annotations = options.findingAnnotations ?? [];
  if (verdict.findings.length > 0 && annotations.length === 0) {
    return refuse(
      'FINDING_ANNOTATIONS_REQUIRED',
      `the closing round raised ${verdict.findings.length} finding(s); verify `
      + 'each against source and supply findingAnnotations — a tool may not '
      + 'stamp them verified',
    );
  }
  if (!DISPATCH_ID_RE.test(options.dispatchId ?? '')) {
    return refuse('INVALID_DISPATCH_ID', 'dispatchId must identify this round\'s reviewer process');
  }
  const previous = evidence.reviewRounds.at(-1);
  const priorFindings = carriedLedger(previous);
  if (priorFindings === null) {
    return refuse(
      'LEDGER_CANNOT_CARRY_FORWARD',
      'a prior finding is neither closed, dispositioned fix, nor rebutted and '
      + 'accepted, so the preceding round did not close it',
    );
  }
  // The closing round is full scope: a delta's changed paths do not carry.
  const { deltaPaths: _deltaPaths, ...inherited } = structuredClone(previous);
  const appended = {
    ...evidence,
    round: evidence.round + 1,
    scope: 'full',
    findingAnnotations: annotations,
    reviewRounds: [
      ...evidence.reviewRounds,
      {
        ...inherited,
        round: previous.round + 1,
        scope: REVIEW_SCOPES.get('full'),
        dispatchId: options.dispatchId,
        deltaBaseOid: previous.headOid,
        priorFindings,
        openRebuttals: [],
        verdict: structuredClone(verdict),
      },
    ],
  };
  return validatedAppend(appended);
}

// Every ordinary round, built by the tool. Until 0.50.0 only the escalation
// round had one, and the rest were hand-assembled: 9 of the 29 permission
// classifier blocks on living-football-engine were `/tmp` evidence programs,
// skeleton JSON, and `jq … > evidence.json`, one of them a 10.3h halt. The
// classifier was right to refuse an ad-hoc program writing review verdicts
// into an audit artifact; this is the sanctioned shape instead.
//
// What is judgement stays the caller's: the dispositions (fix or rebut, with
// the rebuttal) and the finding annotations. Everything else is derived — the
// checkout, the artifact fingerprint, the version, the ledger carry-forward —
// and the result goes through `reviewTransition` before it is returned.
function dispositionLedgerEntry(finding, disposition, predicate) {
  return {
    findingId: finding.id,
    severity: finding.severity,
    summary: finding.summary,
    evidence: finding.evidence,
    ...(predicate === undefined ? {} : { predicate }),
    disposition: disposition.disposition,
    state: 'open',
    rationale: disposition.rationale,
    ...(disposition.disposition === 'widen' ? { paths: [...disposition.paths] } : {}),
    ...(disposition.disposition === 'defer' && disposition.seam !== undefined
      ? { seam: disposition.seam }
      : {}),
  };
}

// SPEC-elastic-scope: a path is outside the unit's seam when its top-level
// package or service directory differs from every boundary entry's, or the
// plan names it out of scope. A monorepo container (`packages/a`) counts as
// the package; a root-level file belongs to the project, never to another
// subsystem. Outside the seam the finding is a repair (`defer` naming the
// seam); inside it the fix is made in the unit (`widen`).
const PACKAGE_CONTAINERS = new Set(['apps', 'libs', 'modules', 'packages', 'services']);

function seamOf(path) {
  const segments = String(path).replace(/\/$/u, '').split('/');
  if (segments.length < 2) return null;
  return PACKAGE_CONTAINERS.has(segments[0]) && segments.length > 2
    ? segments.slice(0, 2).join('/')
    : segments[0];
}

export function outsideSeam(path, plan) {
  const boundary = Array.isArray(plan?.boundary) ? plan.boundary : [];
  const outOfScope = Array.isArray(plan?.outOfScope) ? plan.outOfScope : [];
  if (inLane(path, outOfScope)) return true;
  const seam = seamOf(path);
  if (seam === null) return false;
  return !boundary.some((entry) => seamOf(entry) === seam);
}

// The implementer's own widening (`extraPaths` on an implement result):
// each path outside the plan boundary becomes a scope change recorded before
// round 1, under an `implement:extra-<n>` id. A path already inside the
// boundary is no widening. Refusals are the lane's own.
export function widenFromImplementer(result, boundary) {
  if (result?.ok !== true || (result.extraPaths !== undefined && !Array.isArray(result.extraPaths))) {
    return { ok: false, code: 'INVALID_DISPATCH_RESULT', reason: 'the result is not a successful implement dispatch' };
  }
  if (!validBoundary(boundary)) {
    return { ok: false, code: 'WIDEN_PATH_INVALID', reason: 'the plan boundary is not a list of repository-relative paths' };
  }
  const scopeChanges = [];
  let lane = [...boundary];
  for (const extra of result.extraPaths ?? []) {
    if (!isPlainObject(extra) || typeof extra.path !== 'string' || !boundedText(extra.reason, 1, 4096)) {
      return { ok: false, code: 'WIDEN_PATH_INVALID', reason: 'each extra path needs a path and a reason' };
    }
    if (inLane(extra.path, lane)) continue;
    const widened = widenLane(lane, [extra.path]);
    if (widened.ok !== true) return { ok: false, code: widened.code, reason: `extra path ${extra.path}` };
    lane = widened.lane;
    scopeChanges.push({
      findingId: `implement:extra-${scopeChanges.length + 1}`, paths: [extra.path], rationale: extra.reason,
    });
  }
  return { ok: true, boundary: lane, scopeChanges };
}

export function appendRound(evidence, result, options = {}) {
  const refuse = (code, reason) => ({ ok: false, code, reason });
  const verdict = result?.verdict;
  if (result?.ok !== true || !validReviewVerdict(verdict)) {
    return refuse(
      'INVALID_DISPATCH_RESULT',
      'the dispatch result is not a successful review with a valid verdict',
    );
  }
  const checkout = options.checkout;
  if (!validCheckout(checkout)) {
    return refuse('INVALID_CHECKOUT', 'the checkout snapshot is malformed');
  }
  if (checkout.clean !== true) {
    return refuse(
      'CHECKOUT_DIRTY',
      'the checkout has uncommitted changes — commit the artifact before it is reviewed',
    );
  }
  if (!HASH_RE.test(options.artifactFingerprint ?? '')) {
    return refuse('INVALID_ARTIFACT_FINGERPRINT', 'artifactFingerprint must be a sha256');
  }
  if (!DISPATCH_ID_RE.test(options.dispatchId ?? '')) {
    return refuse('INVALID_DISPATCH_ID', 'dispatchId must identify this round\'s reviewer process');
  }
  const annotations = options.findingAnnotations ?? [];
  if (verdict.findings.length > 0 && annotations.length === 0) {
    return refuse(
      'FINDING_ANNOTATIONS_REQUIRED',
      `the round raised ${verdict.findings.length} finding(s); verify each `
      + 'against source and supply findingAnnotations — a tool may not stamp '
      + 'them verified',
    );
  }
  const reviewerIdentity = [result.engine, result.model]
    .filter((part) => typeof part === 'string' && part.length > 0)
    .join(':');

  let base;
  let priorFindings = [];
  let openRebuttals = [];
  // Protected paths a widening added: the unit's `human:authorize` label.
  const authorize = [];
  if (evidence === null || evidence === undefined) {
    const first = options.first;
    if (
      !isPlainObject(first)
      || !currentProjectConfig(first.projectConfig).ok
      || !HASH_RE.test(first.planFingerprint ?? '')
      || !IDENTITY_RE.test(first.authorIdentity ?? '')
      || !OID_RE.test(first.configuredBaseOid ?? '')
    ) {
      return refuse(
        'INVALID_FIRST_ROUND',
        'the first round needs a valid projectConfig, planFingerprint, '
        + 'authorIdentity and configuredBaseOid',
      );
    }
    if (first.boundary !== undefined && !validBoundary(first.boundary)) {
      return refuse('WIDEN_PATH_INVALID', 'the plan boundary is not a list of repository-relative paths');
    }
    if (first.scopeChanges !== undefined
      && !validScopeChanges(first.scopeChanges, first.boundary ?? [])) {
      return refuse('WIDEN_PATH_INVALID', 'scopeChanges must name paths inside the boundary, each with a finding id and a rationale');
    }
    base = {
      round: 1,
      scope: 'full',
      projectConfig: first.projectConfig,
      planFingerprint: first.planFingerprint,
      configFingerprint: hashValue(first.projectConfig),
      configuredBaseOid: first.configuredBaseOid,
      deltaBaseOid: first.configuredBaseOid,
      authorIdentity: first.authorIdentity,
      artifactVersion: 1,
      reviewRounds: [],
      boundary: first.boundary,
      scopeChanges: first.scopeChanges,
    };
  } else {
    const previous = evidence?.reviewRounds?.at(-1);
    if (!validReviewRound(previous)) {
      return refuse('INVALID_EVIDENCE', 'the evidence carries no valid previous round');
    }
    if (!REVIEW_SCOPES.has(options.scope)) {
      return refuse('INVALID_SCOPE', 'scope must be full or delta');
    }
    // A rework rides every round after the hand-off it reopened; a new one
    // binds to the hand-off this evidence ends on (SPEC-review-rounds §5a).
    let reworkAuthorization = previous.reworkAuthorization;
    if (options.reworkAuthorization !== undefined) {
      const grant = options.reworkAuthorization;
      if (!validReworkAuthorization(grant)
        || !['draft', 'block'].includes(reviewTransition(evidence).state)
        || grant.round !== previous.round
        || grant.evidenceFingerprint !== hashValue(previous)) {
        return refuse(
          'REWORK_NOT_AUTHORIZABLE',
          'a rework names a draft or block hand-off: its round and its reviewEvidenceFingerprint',
        );
      }
      reworkAuthorization = structuredClone(grant);
    }
    // A re-plan round carries its new frozen plan; the contract allows one.
    const planFingerprint = options.planFingerprint ?? previous.planFingerprint;
    if (!HASH_RE.test(planFingerprint)) {
      return refuse('INVALID_PLAN_FINGERPRINT', 'planFingerprint must be a sha256');
    }
    if (planFingerprint !== previous.planFingerprint && options.scope !== 'full') {
      return refuse('INVALID_SCOPE', 'the re-plan round reviews the complete artifact: scope full');
    }
    const predicates = new Map(
      (evidence.findingAnnotations ?? []).map((annotation) => [annotation?.id, annotation?.predicate]),
    );
    const dispositions = new Map(
      (options.dispositions ?? []).map((entry) => [entry?.findingId, entry]),
    );
    // A deferral stands until the unit closes: a reviewer re-raising an already
    // filed finding gets the same deferral, not a new judgement to make.
    for (const entry of previous.priorFindings) {
      if (entry.disposition === 'defer' && !dispositions.has(entry.findingId)) {
        dispositions.set(entry.findingId, {
          findingId: entry.findingId, disposition: 'defer', rationale: entry.rationale,
          ...(entry.seam === undefined ? {} : { seam: entry.seam }),
        });
      }
    }
    const previousGating = gatingFindings(previous.verdict);
    const verified = new Set((evidence.findingAnnotations ?? [])
      .filter((annotation) => annotation?.verified === true).map(({ id }) => id));
    let boundary = evidence.boundary === undefined ? undefined : [...evidence.boundary];
    const scopeChanges = [...(evidence.scopeChanges ?? [])];
    for (const finding of previousGating) {
      const disposition = dispositions.get(finding.id);
      if (!DISPOSITIONS.has(disposition?.disposition)
        || !boundedText(disposition.rationale, 1, 4096)) {
        return refuse(
          'DISPOSITION_REQUIRED',
          `finding ${finding.id} gated the previous round; dispose it as fix, `
          + 'widen (naming the paths outside the boundary), rebut, or defer naming its '
          + 'follow-up #N (a Major raised in 3 rounds, any Major once the fix budget is '
          + 'spent, or a Major outside the seam, naming it), with a rationale',
        );
      }
      if (disposition.disposition === 'rebut'
        && !validRebuttal({
          findingId: finding.id, claim: disposition.claim, evidence: disposition.evidence,
        })) {
        return refuse(
          'REBUTTAL_EVIDENCE_REQUIRED',
          `the rebuttal of ${finding.id} needs a claim and evidence`,
        );
      }
      if (disposition.disposition === 'widen') {
        if (!Array.isArray(disposition.paths) || disposition.paths.length === 0) {
          return refuse('WIDEN_PATHS_REQUIRED', `the widening for ${finding.id} names no path`);
        }
        if (!verified.has(finding.id)) {
          return refuse(
            'WIDEN_UNVERIFIED_FINDING',
            `finding ${finding.id} is not annotated verified; a widening needs a verified finding`,
          );
        }
        const widened = widenLane(boundary ?? [], disposition.paths, options.extraHumanAuthorizationGlobs);
        if (widened.ok !== true) {
          return refuse(widened.code, `the widening for ${finding.id}: ${widened.code} at ${widened.path}`);
        }
        boundary = widened.lane;
        authorize.push(...widened.authorize);
        scopeChanges.push({ findingId: finding.id, paths: [...disposition.paths], rationale: disposition.rationale });
      }
    }
    const previousRebuts = new Map(
      previous.verdict.rebuts.map((rebut) => [rebut.findingId, rebut]),
    );
    const repeated = new Set(previousGating.map(({ id }) => id));
    // Carry-forward is `validCumulativeLedger` read constructively.
    for (const entry of previous.priorFindings) {
      if (repeated.has(entry.findingId)) continue;
      if (!ledgerEntryCloses(entry, previousRebuts)) {
        return refuse(
          'LEDGER_CANNOT_CARRY_FORWARD',
          `prior finding ${entry.findingId} is neither closed, fixed, nor rebutted and accepted`,
        );
      }
      priorFindings.push({ ...entry, state: 'closed' });
    }
    for (const finding of previousGating) {
      const disposition = dispositions.get(finding.id);
      priorFindings.push(dispositionLedgerEntry(finding, disposition, predicates.get(finding.id)));
      if (disposition.disposition === 'rebut') {
        openRebuttals.push({
          findingId: finding.id, claim: disposition.claim, evidence: disposition.evidence,
        });
      }
    }
    base = {
      round: evidence.round + 1,
      scope: options.scope,
      projectConfig: evidence.projectConfig,
      boundary,
      // Absent stays absent: evidence recorded before 0.69.0 gains no key.
      scopeChanges: evidence.scopeChanges === undefined && scopeChanges.length === 0
        ? undefined
        : scopeChanges,
      deltaPaths: options.scope === 'delta' ? options.deltaPaths : undefined,
      reworkAuthorization,
      planFingerprint,
      configFingerprint: previous.configFingerprint,
      configuredBaseOid: previous.configuredBaseOid,
      deltaBaseOid: previous.headOid,
      authorIdentity: previous.authorIdentity,
      // The version counts artifacts, so a round over the same bytes (a
      // closing round, a decision, a deferral) keeps the previous one.
      artifactVersion: options.artifactFingerprint === previous.artifactFingerprint
        ? previous.artifactVersion
        : previous.artifactVersion + 1,
      reviewRounds: evidence.reviewRounds,
    };
  }

  const record = {
    round: base.round,
    scope: REVIEW_SCOPES.get(base.scope),
    dispatchId: options.dispatchId,
    authorIdentity: base.authorIdentity,
    reviewerIdentity,
    planFingerprint: base.planFingerprint,
    repositoryFingerprint: checkout.repositoryFingerprint,
    configFingerprint: base.configFingerprint,
    configuredBaseOid: base.configuredBaseOid,
    deltaBaseOid: base.deltaBaseOid,
    headOid: checkout.headOid,
    artifactVersion: base.artifactVersion,
    artifactFingerprint: options.artifactFingerprint,
    checkout: structuredClone(checkout),
    priorFindings,
    openRebuttals,
    verdict: structuredClone(verdict),
    ...(base.deltaPaths === undefined ? {} : { deltaPaths: [...base.deltaPaths] }),
    ...(base.reworkAuthorization === undefined ? {} : { reworkAuthorization: structuredClone(base.reworkAuthorization) }),
  };
  const appended = {
    round: base.round,
    scope: base.scope,
    projectConfig: structuredClone(base.projectConfig),
    ...(base.boundary === undefined ? {} : { boundary: [...base.boundary] }),
    ...(base.scopeChanges === undefined ? {} : { scopeChanges: structuredClone(base.scopeChanges) }),
    expected: {
      planFingerprint: record.planFingerprint,
      repositoryFingerprint: record.repositoryFingerprint,
      configuredBaseOid: record.configuredBaseOid,
      artifactVersion: record.artifactVersion,
      artifactFingerprint: record.artifactFingerprint,
      headOid: record.headOid,
    },
    findingAnnotations: structuredClone(annotations),
    reviewRounds: [...structuredClone(base.reviewRounds), record],
  };
  const built = validatedAppend(appended);
  return built.ok && authorize.length > 0 ? { ...built, authorize } : built;
}

// The paths a fix delta changed, for the widening coverage of a delta round.
export function deltaPathsOf(root, fromOid) {
  const diff = spawnSync('git', ['diff', '--name-only', '-z', `${fromOid}..HEAD`], {
    cwd: root, encoding: 'utf8', timeout: 15000,
  });
  if (diff.status !== 0) return null;
  return String(diff.stdout ?? '').split('\0').filter((path) => path.length > 0);
}

// The reviewed artifact is its tree: an empty commit or a rebase that
// reproduces the same bytes is the same artifact, and any byte change is not.
export function artifactFingerprintOf(root) {
  const tree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], {
    cwd: root, encoding: 'utf8', timeout: 15000,
  });
  const oid = String(tree.stdout ?? '').trim();
  if (tree.status !== 0 || !OID_RE.test(oid)) return null;
  return hashValue({ tree: oid });
}

export function authorizeReviewPublication(input, targetHeadOid, liveCheckout) {
  const transition = reviewTransition(input);
  const checkoutMatches =
    isPlainObject(transition.reviewedCheckout)
    && hasExactKeys(liveCheckout, CHECKOUT_KEYS)
    && liveCheckout.clean === true
    && hashValue(liveCheckout) === hashValue(transition.reviewedCheckout);
  return {
    authorized:
      OID_RE.test(targetHeadOid ?? '')
      && transition.state === 'clean'
      && transition.publishReviewSuccess === true
      && transition.reviewedHead === targetHeadOid
      && checkoutMatches
      && liveCheckout.headOid === targetHeadOid,
    code: transition.code,
    reviewedHead: transition.reviewedHead ?? null,
    repositoryFingerprint:
      transition.reviewedCheckout?.repositoryFingerprint ?? null,
    reviewEvidenceFingerprint: transition.reviewEvidenceFingerprint ?? null,
    reworkAuthorizations: transition.reworkAuthorizations ?? [],
  };
}

function fixtureProjectConfig() {
  return {
    version: '0.28.0',
    baseBranch: 'main',
    gate: { command: 'npm test', quickCommand: null, setupCommand: null },
    merge: { policy: 'manual' },
    tracker: { provider: 'none' },
    review: { checklistPath: 'docs/agentic/checklist.md' },
  };
}

function oid(seed) {
  return createHash('sha1').update(String(seed)).digest('hex');
}

function hash(seed) {
  return createHash('sha256').update(String(seed)).digest('hex');
}

// Builds the recorded rounds a real run would produce: the ledger, the open
// rebuttals, and the delta base are derived from the preceding round exactly as
// the orchestrator derives them, so a fixture that passes here is a shape the
// loop can actually produce.
function roundFactory(projectConfig = fixtureProjectConfig(), options = {}) {
  const planFingerprint = hash(`plan-${options.seed ?? 'default'}`);
  const repositoryFingerprint = hash(`repo-${options.seed ?? 'default'}`);
  const configuredBaseOid = oid(`base-${options.seed ?? 'default'}`);
  const configFingerprint = hashValue(projectConfig);
  let previous = null;
  let counter = 0;
  return (round, verdict, overrides = {}) => {
    counter += 1;
    const artifactVersion = overrides.artifactVersion ?? round;
    const headOid = overrides.headOid ?? oid(`head-${options.seed}-${counter}`);
    const ledger = new Map(
      (previous?.priorFindings ?? []).map(
        (finding) => [finding.findingId, structuredClone(finding)],
      ),
    );
    if (previous !== null) {
      const previousGating = new Map(
        gatingFindings(previous.verdict).map((finding) => [finding.id, finding]),
      );
      const previousRebuts = new Map(
        previous.verdict.rebuts.map((rebut) => [rebut.findingId, rebut]),
      );
      for (const finding of ledger.values()) {
        if (finding.state === 'closed' || previousGating.has(finding.findingId)) {
          continue;
        }
        finding.state = finding.disposition === 'fix' || finding.disposition === 'defer'
          ? 'closed'
          : previousRebuts.get(finding.findingId)?.status === 'accepted'
            ? 'closed'
            : finding.state;
      }
      for (const prior of previousGating.values()) {
        const rebutted = verdict.rebuts.some(
          ({ findingId }) => findingId === prior.id,
        );
        const deferred = (overrides.defer ?? []).includes(prior.id);
        const widened = overrides.widen?.[prior.id];
        const predicate = options.predicates?.[prior.id];
        ledger.set(prior.id, {
          findingId: prior.id,
          severity: prior.severity,
          summary: prior.summary,
          evidence: prior.evidence,
          ...(predicate === undefined ? {} : { predicate }),
          ...(widened === undefined ? {} : { paths: widened }),
          ...(deferred && overrides.seam !== undefined ? { seam: overrides.seam } : {}),
          disposition: rebutted ? 'rebut' : deferred ? 'defer' : widened ? 'widen' : 'fix',
          state: 'open',
          rationale: rebutted
            ? overrides.rebutRationale ?? 'The author supplied a bounded rebuttal with evidence.'
            : deferred
              ? overrides.deferRationale ?? 'Deferred to follow-up #99.'
              : widened
                ? 'The fix is one directory away; the boundary is widened.'
                : 'The exact fix delta contains the bounded fix.',
        });
      }
    }
    const record = {
      round,
      scope: overrides.scope
        ?? (round === 1 ? REVIEW_SCOPES.get('full') : REVIEW_SCOPES.get('delta')),
      dispatchId: overrides.dispatchId ?? `dispatch-${options.seed}-${counter}`,
      authorIdentity: overrides.authorIdentity ?? 'orchestrator',
      reviewerIdentity: overrides.reviewerIdentity ?? `reviewer-${counter}`,
      // A re-plan's fingerprint carries into the rounds after it, as appendRound carries it.
      planFingerprint: overrides.planFingerprint ?? previous?.planFingerprint ?? planFingerprint,
      repositoryFingerprint: overrides.repositoryFingerprint ?? repositoryFingerprint,
      configFingerprint: overrides.configFingerprint ?? configFingerprint,
      configuredBaseOid,
      deltaBaseOid: overrides.deltaBaseOid === 'configured-base'
        ? configuredBaseOid
        : overrides.deltaBaseOid
        ?? (round === 1 ? configuredBaseOid : previous.headOid),
      headOid,
      artifactVersion,
      artifactFingerprint: overrides.artifactFingerprint
        ?? hash(`artifact-${options.seed}-${counter}`),
      checkout: {
        root: '/fixture/repo',
        repositoryFingerprint: overrides.repositoryFingerprint ?? repositoryFingerprint,
        branch: 'loop/issue-1',
        headOid,
        clean: true,
      },
      priorFindings: overrides.priorFindings ?? [...ledger.values()],
      ...(overrides.deltaPaths === undefined ? {} : { deltaPaths: overrides.deltaPaths }),
      ...(overrides.reworkAuthorization === undefined ? {} : { reworkAuthorization: overrides.reworkAuthorization }),
      openRebuttals: overrides.openRebuttals ?? verdict.rebuts.map(({ findingId }) => ({
        findingId,
        claim: `Re-evaluate ${findingId} against the fix delta.`,
        evidence: `Rebuttal evidence for ${findingId}.`,
      })),
      verdict,
    };
    previous = record;
    return record;
  };
}

function inputFor(rounds, projectConfig = fixtureProjectConfig(), overrides = {}) {
  const current = rounds.at(-1);
  return {
    round: rounds.length,
    scope: rounds.length === 1 ? 'full' : 'delta',
    projectConfig,
    expected: {
      planFingerprint: current.planFingerprint,
      repositoryFingerprint: current.repositoryFingerprint,
      configuredBaseOid: current.configuredBaseOid,
      artifactVersion: current.artifactVersion,
      artifactFingerprint: current.artifactFingerprint,
      headOid: current.headOid,
    },
    findingAnnotations: current.verdict.findings.map(({ id }) => ({
      id,
      verified: true,
      inScope: true,
    })),
    reviewRounds: rounds,
    ...overrides,
  };
}

function selfTest() {
  const finding = {
    id: 'finding-1',
    severity: 'Major',
    summary: 'A gating defect remains',
    evidence: 'src/reviewed.mjs:1',
  };
  const cumulativeFinding = {
    id: 'finding-2',
    severity: 'Major',
    summary: 'A later delta introduces another gating defect',
    evidence: 'src/reviewed.mjs:2',
  };
  const lateFinding = {
    id: 'late-major',
    severity: 'Major',
    summary: 'A late gating defect exists outside the fix delta',
    evidence: 'src/other.mjs:3',
  };
  const pass = { verdict: 'pass', findings: [], rebuts: [] };
  const failWith = (findings, rebuts = []) => ({
    verdict: 'fail',
    findings,
    rebuts,
  });
  const accept = (id, evidence) => ({ findingId: id, status: 'accepted', evidence });
  const reject = (id, evidence) => ({ findingId: id, status: 'rejected', evidence });

  const clean = roundFactory(fixtureProjectConfig(), { seed: 'clean' })(1, pass);

  const acceptedFactory = roundFactory(fixtureProjectConfig(), { seed: 'accepted' });
  const acceptedFirst = acceptedFactory(1, failWith([finding]));
  const accepted = acceptedFactory(2, {
    verdict: 'pass',
    findings: [],
    rebuts: [accept(finding.id, 'The fix closes the finding.')],
  }, { scope: 'full-artifact' });

  const fullFactory = roundFactory(fixtureProjectConfig(), { seed: 'fullclose' });
  const fullFirst = fullFactory(1, failWith([finding]));
  const fullClose = fullFactory(2, {
    verdict: 'pass',
    findings: [],
    rebuts: [accept(finding.id, 'The fix closes the finding.')],
  }, { scope: 'full-artifact' });

  // A round-2 reviewer explaining why a round-1 fix fell short necessarily
  // rewrites the prose. living-football-engine #313 raised both its Majors
  // twice with reworded text and could never publish `agentic/review`.
  const rewordedFinding = {
    id: finding.id,
    severity: finding.severity,
    summary: 'The fix narrows the defect but the gate still passes the original input',
    evidence: 'src/reviewed.mjs:1-9',
  };
  const escalatedFinding = { ...finding, severity: 'Critical' };

  const rewordFactory = roundFactory(fixtureProjectConfig(), { seed: 'reword' });
  const rewordFirst = rewordFactory(1, failWith([finding]));
  const rewordSecond = rewordFactory(2, failWith([rewordedFinding]));
  const rewordClose = rewordFactory(3, pass, { scope: 'full-artifact' });

  const roundOneRebut = roundFactory(fixtureProjectConfig(), { seed: 'rebut1' })(
    1,
    { verdict: 'pass', findings: [], rebuts: [accept(finding.id, 'Agreed at plan review.')] },
  );

  const escalateFactory = roundFactory(fixtureProjectConfig(), { seed: 'escalate' });
  const escalateFirst = escalateFactory(1, failWith([finding]));
  const escalateSecond = escalateFactory(2, failWith([escalatedFinding]));

  const mismatchFactory = roundFactory(fixtureProjectConfig(), { seed: 'mismatch' });
  const mismatchFirst = mismatchFactory(1, failWith([finding]));
  const mismatchDelta = mismatchFactory(2, pass);

  const escalationFactory = roundFactory(fixtureProjectConfig(), { seed: 'escalation' });
  const escalationFirst = escalationFactory(1, failWith([finding]));
  const escalationDelta = escalationFactory(2, pass);
  const widerFactory = roundFactory(fixtureProjectConfig(), { seed: 'wider' });
  const widerFirst = widerFactory(1, failWith([finding]));
  const widerDelta = widerFactory(2, pass);
  const escalationWiderArtifact = widerFactory(3, pass, { scope: 'full-artifact' });

  const escalationClose = escalationFactory(3, pass, {
    scope: 'full-artifact',
    artifactVersion: escalationDelta.artifactVersion,
    artifactFingerprint: escalationDelta.artifactFingerprint,
    headOid: escalationDelta.headOid,
  });

  const fixedFactory = roundFactory(fixtureProjectConfig(), { seed: 'fixed' });
  const fixedFirst = fixedFactory(1, failWith([finding]));
  const fixed = fixedFactory(2, pass, { scope: 'full-artifact' });

  const rejectedFactory = roundFactory(fixtureProjectConfig(), { seed: 'rejected' });
  const rejectedFirst = rejectedFactory(1, failWith([finding]));
  const rejected = rejectedFactory(
    2,
    failWith([finding], [reject(finding.id, 'The evidence does not close it.')]),
  );

  // SPEC-elastic-scope: a widen disposition is a fix in a widened boundary;
  // the delta round after it must cover the added paths.
  const widenFactory = roundFactory(fixtureProjectConfig(), { seed: 'widen' });
  const widenFirst = widenFactory(1, failWith([finding]));
  const widenCovered = widenFactory(2, pass, {
    widen: { [finding.id]: ['lib/b.mjs'] }, deltaPaths: ['src/reviewed.mjs', 'lib/b.mjs'],
  });
  const uncoveredFactory = roundFactory(fixtureProjectConfig(), { seed: 'uncovered' });
  const uncoveredFirst = uncoveredFactory(1, failWith([finding]));
  const widenUncovered = uncoveredFactory(2, pass, {
    widen: { [finding.id]: ['lib/'] }, deltaPaths: ['src/reviewed.mjs'],
  });

  const lateFactory = roundFactory(fixtureProjectConfig(), { seed: 'late' });
  const lateClean = lateFactory(1, pass);
  const late = lateFactory(2, failWith([lateFinding]));

  // A Major the fix keeps missing is deferred to a filed follow-up, not a block.
  const deferRounds = (seed, raised, severity = 'Major', deferRationale = undefined) => {
    const recurring = { ...finding, id: `recurring-${seed}`, severity };
    const factory = roundFactory(fixtureProjectConfig(), { seed });
    const rounds = [];
    for (let round = 1; round <= raised; round += 1) {
      rounds.push(factory(round, failWith([recurring])));
    }
    rounds.push(factory(raised + 1, failWith([recurring]), {
      scope: 'full-artifact', defer: [recurring.id], deferRationale,
    }));
    return rounds;
  };
  const deferredAtThree = deferRounds('defer-3', 3);
  const deferredAtTwo = deferRounds('defer-2', 2);
  const deferredCritical = deferRounds('defer-critical', 3, 'Critical');
  const deferredUnnamed = deferRounds('defer-unnamed', 3, 'Major', 'Deferred for later.');

  // SPEC-review-rounds: round 1 plus three fix rounds, each re-raising one
  // Major, spends the fix budget at round 4. What follows is a decision, a
  // re-plan, or a deferral — never a fourth fix.
  const sameArtifactAs = (record) => ({
    scope: 'full-artifact',
    artifactVersion: record.artifactVersion,
    artifactFingerprint: record.artifactFingerprint,
    headOid: record.headOid,
  });
  const decisionLink = 'Decided: https://example.test/acme/widgets/issues/1#issuecomment-77';
  const spentChain = (seed, fourth = null, options = {}) => {
    const major = { ...finding, id: `budget-${seed}` };
    const factory = roundFactory(fixtureProjectConfig(), { seed, ...options });
    const rounds = [1, 2, 3].map((round) => factory(round, failWith([major])));
    rounds.push(factory(4, fourth ?? failWith([major])));
    return { factory, rounds, major };
  };
  const spent = spentChain('spent');
  const fourthFix = spentChain('fourth-fix');
  fourthFix.rounds.push(fourthFix.factory(5, failWith([fourthFix.major])));
  const decided = spentChain('decided');
  const decidedClose = decided.factory(5, {
    verdict: 'pass', findings: [], rebuts: [accept(decided.major.id, 'The decision stands.')],
  }, { ...sameArtifactAs(decided.rounds[3]), rebutRationale: decisionLink });
  const undecided = spentChain('undecided');
  const undecidedClose = undecided.factory(5, {
    verdict: 'pass', findings: [], rebuts: [accept(undecided.major.id, 'Accepted.')],
  }, sameArtifactAs(undecided.rounds[3]));
  const rejectedDecision = spentChain('rejected-decision');
  const rejectedDecisionClose = rejectedDecision.factory(5, failWith(
    [rejectedDecision.major], [reject(rejectedDecision.major.id, 'Still reproduces.')],
  ), { ...sameArtifactAs(rejectedDecision.rounds[3]), rebutRationale: decisionLink });
  const secondDecision = rejectedDecision.factory(6, {
    verdict: 'pass', findings: [], rebuts: [accept(rejectedDecision.major.id, 'Fine.')],
  }, { ...sameArtifactAs(rejectedDecisionClose), rebutRationale: decisionLink });
  const replanned = spentChain('replanned');
  const replanClean = replanned.factory(5, pass, {
    scope: 'full-artifact', planFingerprint: hash('plan-replanned-v2'),
  });
  const replanOpen = spentChain('replan-open');
  const replanStillMajor = replanOpen.factory(5, failWith([replanOpen.major]), {
    scope: 'full-artifact', planFingerprint: hash('plan-replan-open-v2'),
  });
  const secondReplan = replanOpen.factory(6, pass, {
    scope: 'full-artifact', planFingerprint: hash('plan-replan-open-v3'),
  });
  const replanDelta = spentChain('replan-delta');
  const replanDeltaRound = replanDelta.factory(5, pass, {
    planFingerprint: hash('plan-replan-delta-v2'),
  });
  // A Critical the re-plan round is the first to see gets one fix round and
  // the closing full round; a second fix round is refused, and a Critical
  // still open after the admitted round is the human's.
  const criticalInReplan = { ...cumulativeFinding, id: 'critical-after-replan', severity: 'Critical' };
  const replanCritical = spentChain('replan-critical');
  const replanStillCritical = replanCritical.factory(5, failWith([criticalInReplan]),
    { scope: 'full-artifact', planFingerprint: hash('plan-replan-critical-v2') });
  const replanCriticalFixed = replanCritical.factory(6, pass);
  const replanCriticalClose = replanCritical.factory(7, pass, sameArtifactAs(replanCriticalFixed));
  const replanCriticalOpen = spentChain('replan-critical-open');
  const replanCriticalOpenRounds = [
    replanCriticalOpen.factory(5, failWith([criticalInReplan]),
      { scope: 'full-artifact', planFingerprint: hash('plan-replan-critical-open-v2') }),
    replanCriticalOpen.factory(6, failWith([criticalInReplan])),
  ];
  const replanCriticalSecondFix = replanCriticalOpen.factory(7, failWith([criticalInReplan]));
  // SPEC-review-rounds §5a: after the hand-off a rework a human answered, or
  // the one the loop decided, admits one fix round and the closing full
  // round, bound to the hand-off round's exact evidence.
  const reworkChain = (seed, handoffVerdict = null) => {
    const chain = spentChain(seed);
    const handoff = chain.factory(5, handoffVerdict ?? failWith([chain.major]),
      { scope: 'full-artifact', planFingerprint: hash(`plan-${seed}-v2`) });
    const grant = (from, kind = 'answer', comment = 88) => ({
      kind, issue: 1, comment: `https://example.test/acme/widgets/issues/1#issuecomment-${comment}`,
      round: from.round, evidenceFingerprint: hashValue(from),
    });
    return { ...chain, rounds: [...chain.rounds, handoff], handoff, grant };
  };
  const rework = reworkChain('rework');
  const reworkGrant = rework.grant(rework.handoff);
  const reworkFixed = rework.factory(6, pass, { reworkAuthorization: reworkGrant });
  const reworkClose = rework.factory(7, pass, { ...sameArtifactAs(reworkFixed), reworkAuthorization: reworkGrant });
  const reworkPast = rework.factory(8, pass, { ...sameArtifactAs(reworkClose), reworkAuthorization: reworkGrant });
  const unauthorized = reworkChain('rework-unauthorized');
  const unauthorizedFix = unauthorized.factory(6, pass);
  const mismatched = reworkChain('rework-mismatch');
  const mismatchedFix = mismatched.factory(6, pass, {
    reworkAuthorization: { ...mismatched.grant(mismatched.handoff), evidenceFingerprint: hash('another hand-off') },
  });
  const stillOpen = reworkChain('rework-still-open');
  const stillOpenFix = stillOpen.factory(6, failWith([stillOpen.major]), { reworkAuthorization: stillOpen.grant(stillOpen.handoff, 'decision') });
  const secondRework = reworkChain('rework-second-decision');
  const secondReworkRounds = [secondRework.factory(6, failWith([secondRework.major]),
    { reworkAuthorization: secondRework.grant(secondRework.handoff, 'decision') })];
  secondReworkRounds.push(secondRework.factory(7, pass,
    { reworkAuthorization: secondRework.grant(secondReworkRounds[0], 'decision', 89) }));
  const answerAfterDecision = reworkChain('rework-answer-after-decision');
  const answerAfterDecisionRounds = [answerAfterDecision.factory(6, failWith([answerAfterDecision.major]),
    { reworkAuthorization: answerAfterDecision.grant(answerAfterDecision.handoff, 'decision') })];
  answerAfterDecisionRounds.push(answerAfterDecision.factory(7, pass,
    { reworkAuthorization: answerAfterDecision.grant(answerAfterDecisionRounds[0], 'answer', 90) }));
  const noReplan = spentChain('rework-no-replan');
  const noReplanFix = noReplan.factory(5, pass, { reworkAuthorization: {
    kind: 'answer', issue: 1, comment: 'https://example.test/acme/widgets/issues/1#issuecomment-91',
    round: 4, evidenceFingerprint: hashValue(noReplan.rounds[3]),
  } });
  const closeFix = reworkChain('rework-close-fix');
  const closeFixRounds = [closeFix.factory(6, failWith([closeFix.major]), { reworkAuthorization: closeFix.grant(closeFix.handoff) })];
  closeFixRounds.push(closeFix.factory(7, pass, { scope: 'full-artifact', reworkAuthorization: closeFix.grant(closeFix.handoff) }));
  const closeDelta = reworkChain('rework-close-delta');
  const closeDeltaRounds = [closeDelta.factory(6, pass, { reworkAuthorization: closeDelta.grant(closeDelta.handoff) })];
  closeDeltaRounds.push(closeDelta.factory(7, pass, { reworkAuthorization: closeDelta.grant(closeDelta.handoff) }));
  const skippedFix = reworkChain('rework-skipped-fix');
  const skippedFixRounds = [skippedFix.factory(6, pass, { ...sameArtifactAs(skippedFix.handoff), defer: [skippedFix.major.id], seam: 'services/billing' })];
  skippedFixRounds.push(skippedFix.factory(7, pass, { ...sameArtifactAs(skippedFixRounds[0]), reworkAuthorization: skippedFix.grant(skippedFix.handoff) }));
  const newPlan = reworkChain('rework-new-plan');
  const newPlanFix = newPlan.factory(6, pass, {
    scope: 'full-artifact', planFingerprint: hash('plan-rework-new-plan-v3'), reworkAuthorization: newPlan.grant(newPlan.handoff),
  });
  const otherGrant = reworkChain('rework-other-grant');
  const otherGrantRounds = [otherGrant.factory(6, pass, { reworkAuthorization: otherGrant.grant(otherGrant.handoff) })];
  otherGrantRounds.push(otherGrant.factory(7, pass, {
    ...sameArtifactAs(otherGrantRounds[0]), reworkAuthorization: otherGrant.grant(otherGrant.handoff, 'answer', 93),
  }));
  const firstRoundGrant = roundFactory(fixtureProjectConfig(), { seed: 'rework-first' })(1, pass, { reworkAuthorization: {
    kind: 'answer', issue: 1, comment: 'https://example.test/acme/widgets/issues/1#issuecomment-92', round: 1, evidenceFingerprint: hash('none'),
  } });
  const criticalHandoff = reworkChain('rework-critical', failWith([criticalInReplan]));
  const criticalHandoffFix = criticalHandoff.factory(6, pass, { reworkAuthorization: criticalHandoff.grant(criticalHandoff.handoff) });
  // The rework fixes: neither of its rounds defers the open Major bare (no
  // seam) and publishes clean.
  const bareDefer = reworkChain('rework-bare-defer');
  const bareDeferFix = bareDefer.factory(6, pass, {
    defer: [bareDefer.major.id], reworkAuthorization: bareDefer.grant(bareDefer.handoff),
  });
  const bareClose = reworkChain('rework-bare-close');
  const bareCloseRounds = [bareClose.factory(6, failWith([bareClose.major]), { reworkAuthorization: bareClose.grant(bareClose.handoff) })];
  bareCloseRounds.push(bareClose.factory(7, pass, {
    ...sameArtifactAs(bareCloseRounds[0]), scope: 'full-artifact', defer: [bareClose.major.id],
    reworkAuthorization: bareClose.grant(bareClose.handoff),
  }));
  const bareRebut = reworkChain('rework-bare-rebut');
  const bareRebutFix = bareRebut.factory(6, {
    verdict: 'pass', findings: [], rebuts: [accept(bareRebut.major.id, 'Accepted.')],
  }, { reworkAuthorization: bareRebut.grant(bareRebut.handoff) });
  const replanBareClose = spentChain('replan-bare-close');
  const replanBareMajor = { ...finding, id: 'major-after-critical-fix' };
  const replanBareCloseRounds = [
    replanBareClose.factory(5, failWith([criticalInReplan]),
      { scope: 'full-artifact', planFingerprint: hash('plan-replan-bare-close-v2') }),
  ];
  replanBareCloseRounds.push(replanBareClose.factory(6, failWith([replanBareMajor])));
  replanBareCloseRounds.push(replanBareClose.factory(7, pass, {
    ...sameArtifactAs(replanBareCloseRounds[1]), scope: 'full-artifact', defer: [replanBareMajor.id],
  }));
  // A deferral standing from an earlier round carries as it stands: the limit
  // binds a new deferral after the re-plan, not one already filed.
  const replanSeam = spentChain('replan-seam');
  const replanSeamMajor = { ...finding, id: 'major-seam-after-replan' };
  const replanSeamRounds = [
    replanSeam.factory(5, failWith([criticalInReplan, replanSeamMajor]),
      { scope: 'full-artifact', planFingerprint: hash('plan-replan-seam-v2') }),
  ];
  replanSeamRounds.push(replanSeam.factory(6, failWith([replanSeamMajor]), { defer: [replanSeamMajor.id], seam: 'services/billing' }));
  replanSeamRounds.push(replanSeam.factory(7, pass, {
    ...sameArtifactAs(replanSeamRounds[1]), scope: 'full-artifact', defer: [replanSeamMajor.id],
  }));
  const predeferred = spentChain('rework-predeferred');
  const predeferredMajor = { ...finding, id: 'major-in-rework-replan' };
  predeferred.rounds.push(predeferred.factory(5, failWith([predeferred.major, predeferredMajor]), {
    scope: 'full-artifact', planFingerprint: hash('plan-rework-predeferred-v2'), defer: [predeferred.major.id],
  }));
  const predeferredFix = predeferred.factory(6, pass, {
    defer: [predeferred.major.id], reworkAuthorization: {
      kind: 'answer', issue: 1, comment: 'https://example.test/acme/widgets/issues/1#issuecomment-94',
      round: 5, evidenceFingerprint: hashValue(predeferred.rounds[4]),
    },
  });
  // A round whose only gating finding is already deferred is no hand-off.
  const deferredOnly = spentChain('rework-deferred-only');
  deferredOnly.rounds.push(deferredOnly.factory(5, failWith([deferredOnly.major]), {
    scope: 'full-artifact', planFingerprint: hash('plan-rework-deferred-only-v2'), defer: [deferredOnly.major.id],
  }));
  const deferredOnlyFix = deferredOnly.factory(6, pass, {
    defer: [deferredOnly.major.id], reworkAuthorization: {
      kind: 'answer', issue: 1, comment: 'https://example.test/acme/widgets/issues/1#issuecomment-95',
      round: 5, evidenceFingerprint: hashValue(deferredOnly.rounds[4]),
    },
  });
  // A Critical outside the delta of the round after the hand-off is the
  // human's: no fix round follows it to widen into.
  const outsideCritical = { ...cumulativeFinding, id: 'critical-outside-delta', severity: 'Critical' };
  const outsideAnnotations = [{ id: outsideCritical.id, verified: true, inScope: false }];
  const reworkOutside = reworkChain('rework-outside');
  const reworkOutsideFix = reworkOutside.factory(6, failWith([outsideCritical]), { reworkAuthorization: reworkOutside.grant(reworkOutside.handoff) });
  const replanOutside = spentChain('replan-outside');
  const replanOutsideRounds = [
    replanOutside.factory(5, failWith([criticalInReplan]),
      { scope: 'full-artifact', planFingerprint: hash('plan-replan-outside-v2') }),
  ];
  replanOutsideRounds.push(replanOutside.factory(6, failWith([outsideCritical])));
  // A Major first seen in the re-plan round may be deferred outside the seam
  // (or decided) in the closing round instead of handed off.
  const replanDefer = spentChain('replan-defer');
  const replanDeferMajor = { ...finding, id: 'major-after-replan' };
  const replanDeferRounds = [
    replanDefer.factory(5, failWith([replanDeferMajor]),
      { scope: 'full-artifact', planFingerprint: hash('plan-replan-defer-v2') }),
  ];
  replanDeferRounds.push(replanDefer.factory(6, pass, {
    ...sameArtifactAs(replanDeferRounds[0]), defer: [replanDeferMajor.id], seam: 'services/billing',
  }));
  // A Critical raised once the budget is spent is still fixed in the next round.
  const criticalFinding = { ...cumulativeFinding, id: 'critical-round-4', severity: 'Critical' };
  const lateCritical = spentChain('late-critical', failWith([{ ...finding, id: 'budget-late-critical' }, criticalFinding]));
  const lateCriticalFixed = lateCritical.factory(5, pass);
  // A Major first raised in the last fix round may be deferred once the budget
  // is spent, although it was raised only once.
  const lateMajorFactory = roundFactory(fixtureProjectConfig(), { seed: 'late-major-defer' });
  const lateMajor = { ...finding, id: 'late-major-defer' };
  const lateMajorRounds = [1, 2, 3].map((round) => lateMajorFactory(round, failWith([finding])));
  lateMajorRounds.push(lateMajorFactory(4, failWith([lateMajor])));
  lateMajorRounds.push(lateMajorFactory(5, failWith([lateMajor]), {
    scope: 'full-artifact', defer: [lateMajor.id],
  }));
  // Minors never consume the budget and never hold delivery.
  const minor = { id: 'minor-1', severity: 'Minor', summary: 'A nit', evidence: 'src/reviewed.mjs:7' };
  const minorOnly = spentChain('minor-only', { verdict: 'pass', findings: [minor], rebuts: [] });
  const minorClose = minorOnly.factory(5, { verdict: 'pass', findings: [minor], rebuts: [] },
    sameArtifactAs(minorOnly.rounds[3]));
  // A re-filed Major on the same predicate is the same finding: its raisings
  // count under the predicate, not under the new id.
  const refiled = { ...rewordedFinding, id: 'finding-9' };
  const predicates = { [finding.id]: 'rule:gate', [refiled.id]: 'rule:gate' };
  const refiledFactory = roundFactory(fixtureProjectConfig(), { seed: 'refiled', predicates });
  const refiledRounds = [
    refiledFactory(1, failWith([finding])),
    refiledFactory(2, failWith([refiled])),
    refiledFactory(3, failWith([refiled])),
  ];
  refiledRounds.push(refiledFactory(4, failWith([refiled]), { scope: 'full-artifact', defer: [refiled.id] }));
  const refiledInput = inputFor(refiledRounds, fixtureProjectConfig(), { scope: 'full' });
  refiledInput.findingAnnotations = [{ id: refiled.id, verified: true, inScope: true, predicate: 'rule:gate' }];

  const wrongDeltaFactory = roundFactory(fixtureProjectConfig(), { seed: 'wrong-delta' });
  const wrongDeltaFirst = wrongDeltaFactory(1, failWith([finding]));
  const wrongDelta = wrongDeltaFactory(2, {
    verdict: 'pass',
    findings: [],
    rebuts: [accept(finding.id, 'The wrong range cannot prove convergence.')],
  }, { deltaBaseOid: 'configured-base' });

  const omittedLedgerFactory = roundFactory(fixtureProjectConfig(), { seed: 'omitted' });
  const omittedLedgerFirst = omittedLedgerFactory(1, failWith([finding]));
  const omittedLedger = omittedLedgerFactory(2, pass, {
    priorFindings: [{
      findingId: 'unrelated-finding',
      severity: 'Major',
      summary: 'An unrelated finding cannot replace the prior ledger.',
      evidence: 'src/unrelated.mjs:1',
      disposition: 'fix',
      state: 'open',
      rationale: 'The caller substituted a different finding.',
    }],
  });

  const reusedFactory = roundFactory(fixtureProjectConfig(), { seed: 'reused' });
  const reusedFirst = reusedFactory(1, failWith([finding]));
  const reused = reusedFactory(2, {
    verdict: 'pass',
    findings: [],
    rebuts: [accept(finding.id, 'A repeated dispatch is not a fresh review.')],
  }, { dispatchId: 'dispatch-reused-1' });

  const switchedFactory = roundFactory(fixtureProjectConfig(), { seed: 'switched' });
  const switchedFirst = switchedFactory(1, failWith([finding]));
  const switched = switchedFactory(2, {
    verdict: 'pass',
    findings: [],
    rebuts: [accept(finding.id, 'A different repository cannot continue this chain.')],
  }, { repositoryFingerprint: hash('other-repository') });

  const collidedFactory = roundFactory(fixtureProjectConfig(), { seed: 'collided' });
  const collided = collidedFactory(1, pass, { reviewerIdentity: 'orchestrator' });
  // The same model spelled two ways (the dispatch stamps [1m], the skill's
  // --author example does not) is still the writer reviewing itself.
  const respelledFactory = roundFactory(fixtureProjectConfig(), { seed: 'respelled' });
  const respelled = respelledFactory(1, pass, {
    authorIdentity: 'claude:claude-opus-5-5', reviewerIdentity: 'claude:claude-opus-5-5[1m]',
  });

  const cumulativeFactory = roundFactory(fixtureProjectConfig(), { seed: 'cumulative' });
  const cumulativeFirst = cumulativeFactory(1, failWith([finding]));
  const cumulativeSecond = cumulativeFactory(2, failWith([cumulativeFinding]));
  const cumulativeThird = cumulativeFactory(3, pass, { scope: 'full-artifact' });

  const omittedHistoryFactory = roundFactory(fixtureProjectConfig(), { seed: 'history' });
  const omittedHistoryFirst = omittedHistoryFactory(1, failWith([finding]));
  const omittedHistorySecond = omittedHistoryFactory(2, failWith([cumulativeFinding]));
  const omittedHistoryThird = omittedHistoryFactory(3, pass, {
    priorFindings: [{
      findingId: cumulativeFinding.id,
      severity: cumulativeFinding.severity,
      summary: cumulativeFinding.summary,
      evidence: cumulativeFinding.evidence,
      disposition: 'fix',
      state: 'open',
      rationale: 'The exact fix delta contains the bounded fix.',
    }],
  });

  const mutatedFactory = roundFactory(fixtureProjectConfig(), { seed: 'mutated' });
  const mutatedFirst = mutatedFactory(1, failWith([finding]));
  const mutatedSecond = mutatedFactory(2, failWith([cumulativeFinding]));
  const mutatedThird = mutatedFactory(3, pass, {
    priorFindings: [
      {
        findingId: finding.id,
        severity: finding.severity,
        summary: 'The historical finding was silently rewritten.',
        evidence: finding.evidence,
        disposition: 'fix',
        state: 'closed',
        rationale: 'The exact fix delta contains the bounded fix.',
      },
      {
        findingId: cumulativeFinding.id,
        severity: cumulativeFinding.severity,
        summary: cumulativeFinding.summary,
        evidence: cumulativeFinding.evidence,
        disposition: 'fix',
        state: 'open',
        rationale: 'The exact fix delta contains the bounded fix.',
      },
    ],
  });

  const cases = [
    {
      name: 'clean full review publishes success',
      input: inputFor([clean]),
      expected: ['clean', true],
    },
    {
      // 0.46.0 skill rule, previously unexecutable: convergence closes on a
      // full-artifact round. Round 2 with full scope was INVALID_REVIEW_INPUT.
      name: 'a clean full-artifact closing round publishes success',
      input: inputFor(
        [fullFirst, fullClose],
        fixtureProjectConfig(),
        { scope: 'full' },
      ),
      expected: ['clean', true],
    },
    {
      name: 'a later reviewer may reword a re-raised finding',
      input: inputFor(
        [rewordFirst, rewordSecond, rewordClose],
        fixtureProjectConfig(),
        { scope: 'full' },
      ),
      expected: ['clean', true],
    },
    {
      name: 'a re-raised finding may not change severity',
      input: inputFor([escalateFirst, escalateSecond]),
      expected: ['error', false],
      expectedGap: 'a finding id is immutable',
    },
    {
      // The failure that cost living-football-engine #314 a bisect: the only
      // signal was a bare INVALID_REVIEW_EVIDENCE for one wrong word.
      name: 'a transition scope that disagrees with the closing round names itself',
      input: inputFor(
        [mismatchFirst, mismatchDelta],
        fixtureProjectConfig(),
        { scope: 'full' },
      ),
      expected: ['error', false],
      expectedGap: 'records scope',
    },
    {
      name: 'a round-1 verdict carrying rebuts names the rule it broke',
      input: inputFor([roundOneRebut]),
      expected: ['error', false],
      expectedGap: 'round 1 has no prior round',
    },
    {
      name: 'convergence may not close on a delta round',
      input: inputFor([mismatchFirst, mismatchDelta]),
      expected: ['continue', false],
      expectedCode: 'REVIEW_FULL_CLOSE_REQUIRED',
    },
    {
      name: 'a full round over a changed artifact after a clean delta is an ordinary round',
      input: inputFor(
        [widerFirst, widerDelta, escalationWiderArtifact],
        fixtureProjectConfig(),
        { scope: 'full' },
      ),
      expected: ['clean', true],
    },
    {
      name: 'a full-artifact round re-reading the delta head closes the review',
      input: inputFor(
        [escalationFirst, escalationDelta, escalationClose],
        fixtureProjectConfig(),
        { scope: 'full' },
      ),
      expected: ['clean', true],
    },
    {
      name: 'a Major continues within the fix budget',
      input: inputFor([acceptedFirst]),
      expected: ['continue', false],
      expectedCode: 'REVIEW_FIX_DELTA_REQUIRED',
    },
    {
      name: 'an accepted rebut permits a clean result',
      input: inputFor(
        [acceptedFirst, accepted],
        fixtureProjectConfig(),
        { scope: 'full' },
      ),
      expected: ['clean', true],
    },
    {
      name: 'a reviewed fix permits a clean result',
      input: inputFor(
        [fixedFirst, fixed],
        fixtureProjectConfig(),
        { scope: 'full' },
      ),
      expected: ['clean', true],
    },
    {
      name: 'a rejected rebut continues',
      input: inputFor([rejectedFirst, rejected]),
      expected: ['continue', false],
    },
    {
      name: 'a verified out-of-delta Major continues with a full round',
      input: {
        ...inputFor([lateClean, late]),
        findingAnnotations: [{ id: lateFinding.id, verified: true, inScope: false }],
      },
      expected: ['continue', false],
      expectedCode: 'REVIEW_FULL_ROUND_REQUIRED',
    },
    {
      name: 'an unverified gating finding requires verification',
      input: {
        ...inputFor([acceptedFirst]),
        findingAnnotations: [{ id: finding.id, verified: false, inScope: true }],
      },
      expected: ['verify', false],
    },
    {
      name: 'a Major raised in three rounds may be deferred to a named follow-up',
      input: inputFor(deferredAtThree, fixtureProjectConfig(), { scope: 'full' }),
      expected: ['clean', true],
    },
    {
      name: 'a finding raised only twice may not be deferred',
      input: inputFor(deferredAtTwo, fixtureProjectConfig(), { scope: 'full' }),
      expected: ['error', false],
      expectedGap: 'deferred',
    },
    {
      name: 'a Critical is never deferred',
      input: inputFor(deferredCritical, fixtureProjectConfig(), { scope: 'full' }),
      expected: ['error', false],
    },
    {
      name: 'a deferral must name its follow-up issue',
      input: inputFor(deferredUnnamed, fixtureProjectConfig(), { scope: 'full' }),
      expected: ['error', false],
    },
    // SPEC-review-rounds: on one project 12 units reached a 20-round cap and
    // rounds after the third did not converge. Round 1 plus three fix rounds
    // is the budget; a Major still open then is decided, re-planned once, or
    // deferred.
    {
      name: 'three fix rounds spend the budget: a Major still open is decided, re-planned or deferred',
      input: inputFor(spent.rounds),
      expected: ['continue', false],
      expectedCode: 'REVIEW_REPLAN',
    },
    {
      name: 'a fourth fix round is refused',
      input: inputFor(fourthFix.rounds),
      expected: ['error', false],
      expectedCode: 'REVIEW_FIX_BUDGET_SPENT',
    },
    {
      name: 'a decision rebuts the finding and one closing full round over the same artifact closes it',
      input: inputFor([...decided.rounds, decidedClose], fixtureProjectConfig(), { scope: 'full' }),
      expected: ['clean', true],
      expectedCode: 'REVIEW_CLEAN',
    },
    {
      name: 'after the budget a rebuttal must carry its decision link',
      input: inputFor([...undecided.rounds, undecidedClose], fixtureProjectConfig(), { scope: 'full' }),
      expected: ['error', false],
      expectedGap: 'decision',
    },
    {
      name: 'a decision the closing reviewer rejects leaves re-plan or defer',
      input: inputFor([...rejectedDecision.rounds, rejectedDecisionClose], fixtureProjectConfig(), { scope: 'full' }),
      expected: ['continue', false],
      expectedCode: 'REVIEW_REPLAN',
    },
    {
      name: 'a rejected decision is not decided again',
      input: inputFor([...rejectedDecision.rounds, rejectedDecisionClose, secondDecision], fixtureProjectConfig(), { scope: 'full' }),
      expected: ['error', false],
      expectedCode: 'REVIEW_FIX_BUDGET_SPENT',
    },
    {
      name: 'a re-plan round is a new plan reviewed whole, and a clean one delivers',
      input: inputFor([...replanned.rounds, replanClean], fixtureProjectConfig(), { scope: 'full' }),
      expected: ['clean', true],
      expectedCode: 'REVIEW_CLEAN',
    },
    {
      name: 'a Major surviving the re-plan round hands the unit off as a draft with its ledger',
      input: inputFor([...replanOpen.rounds, replanStillMajor], fixtureProjectConfig(), { scope: 'full' }),
      expected: ['draft', false],
      expectedCode: 'REVIEW_OPEN_FINDINGS',
    },
    {
      name: 'a second re-plan is refused',
      input: inputFor([...replanOpen.rounds, replanStillMajor, secondReplan], fixtureProjectConfig(), { scope: 'full' }),
      expected: ['error', false],
      expectedCode: 'REVIEW_REPLAN_SPENT',
    },
    {
      name: 'an authorized rework after the hand-off admits one fix round',
      input: inputFor([...rework.rounds, reworkFixed]),
      expected: ['continue', false],
      expectedCode: 'REVIEW_FULL_CLOSE_REQUIRED',
    },
    {
      name: 'the closing round of an authorized rework delivers',
      input: inputFor([...rework.rounds, reworkFixed, reworkClose], fixtureProjectConfig(), { scope: 'full' }),
      expected: ['clean', true],
      expectedCode: 'REVIEW_CLEAN',
    },
    {
      name: 'a round past the closing round of a rework is refused',
      input: inputFor([...rework.rounds, reworkFixed, reworkClose, reworkPast], fixtureProjectConfig(), { scope: 'full' }),
      expected: ['error', false],
      expectedCode: 'REVIEW_REWORK_SPENT',
    },
    {
      name: 'a fix after the hand-off without an authorization is still refused',
      input: inputFor([...unauthorized.rounds, unauthorizedFix]),
      expected: ['error', false],
      expectedCode: 'REVIEW_REPLAN_SPENT',
    },
    {
      name: 'a rework bound to other evidence than the hand-off round is refused',
      input: inputFor([...mismatched.rounds, mismatchedFix]),
      expected: ['error', false],
      expectedCode: 'REVIEW_REWORK_SPENT',
    },
    {
      name: 'a Major still open after the rework fix round is handed off again',
      input: inputFor([...stillOpen.rounds, stillOpenFix]),
      expected: ['draft', false],
      expectedCode: 'REVIEW_OPEN_FINDINGS',
    },
    {
      name: 'the loop decides one rework per unit; a second decided rework is refused',
      input: inputFor([...secondRework.rounds, ...secondReworkRounds]),
      expected: ['error', false],
      expectedCode: 'REVIEW_REWORK_SPENT',
    },
    {
      name: 'a human answer may grant a rework after the decided one',
      input: inputFor([...answerAfterDecision.rounds, ...answerAfterDecisionRounds]),
      expected: ['continue', false],
      expectedCode: 'REVIEW_FULL_CLOSE_REQUIRED',
    },
    {
      name: 'the closing round of a rework fixes nothing',
      input: inputFor([...closeFix.rounds, ...closeFixRounds], fixtureProjectConfig(), { scope: 'full' }),
      expected: ['error', false],
      expectedCode: 'REVIEW_REWORK_SPENT',
    },
    {
      name: 'the closing round of a rework reviews the complete artifact',
      input: inputFor([...closeDelta.rounds, ...closeDeltaRounds]),
      expected: ['error', false],
      expectedCode: 'REVIEW_REWORK_SPENT',
    },
    {
      name: 'a rework closing round needs the rework fix round before it',
      input: inputFor([...skippedFix.rounds, ...skippedFixRounds], fixtureProjectConfig(), { scope: 'full' }),
      expected: ['error', false],
      expectedCode: 'REVIEW_REWORK_SPENT',
    },
    {
      name: 'a rework keeps the plan: a new plan is a second re-plan',
      input: inputFor([...newPlan.rounds, newPlanFix], fixtureProjectConfig(), { scope: 'full' }),
      expected: ['error', false],
      expectedCode: 'REVIEW_REWORK_SPENT',
    },
    {
      name: 'the closing round carries the rework of its fix round',
      input: inputFor([...otherGrant.rounds, ...otherGrantRounds], fixtureProjectConfig(), { scope: 'full' }),
      expected: ['error', false],
      expectedCode: 'REVIEW_REWORK_SPENT',
    },
    {
      name: 'round 1 carries no rework',
      input: inputFor([firstRoundGrant]),
      expected: ['error', false],
      expectedCode: 'REVIEW_REWORK_SPENT',
    },
    {
      name: 'a rework follows the re-plan hand-off only',
      input: inputFor([...noReplan.rounds, noReplanFix]),
      expected: ['error', false],
      expectedCode: 'REVIEW_REWORK_SPENT',
    },
    {
      name: 'a re-plan round whose Critical is still fixed in the next round is no hand-off to rework',
      input: inputFor([...criticalHandoff.rounds, criticalHandoffFix]),
      expected: ['error', false],
      expectedCode: 'REVIEW_REWORK_SPENT',
    },
    {
      name: 'the rework fix round defers no Major bare',
      input: inputFor([...bareDefer.rounds, bareDeferFix]),
      expected: ['error', false],
      expectedCode: 'REVIEW_REWORK_SPENT',
    },
    {
      name: 'the rework fix round rebuts no Major without its decision comment',
      input: inputFor([...bareRebut.rounds, bareRebutFix]),
      expected: ['error', false],
      expectedCode: 'REVIEW_REWORK_SPENT',
    },
    {
      name: 'the rework closing round defers no Major its fix round left open bare',
      input: inputFor([...bareClose.rounds, ...bareCloseRounds], fixtureProjectConfig(), { scope: 'full' }),
      expected: ['error', false],
      expectedCode: 'REVIEW_REWORK_SPENT',
    },
    {
      name: 'the closing round after the re-plan Critical fix defers no Major bare',
      input: inputFor([...replanBareClose.rounds, ...replanBareCloseRounds], fixtureProjectConfig(), { scope: 'full' }),
      expected: ['error', false],
      expectedCode: 'REVIEW_REPLAN_SPENT',
    },
    {
      name: 'a seam deferral standing from the round after the re-plan carries into its closing round',
      input: inputFor([...replanSeam.rounds, ...replanSeamRounds], fixtureProjectConfig(), { scope: 'full' }),
      expected: ['clean', true],
      expectedCode: 'REVIEW_CLEAN',
    },
    {
      name: 'a deferral standing from before the re-plan carries into the rework fix round',
      input: inputFor([...predeferred.rounds, predeferredFix]),
      expected: ['continue', false],
      expectedCode: 'REVIEW_FULL_CLOSE_REQUIRED',
    },
    {
      name: 'a round whose only gating finding is already deferred is no hand-off to rework',
      input: inputFor([...deferredOnly.rounds, deferredOnlyFix]),
      expected: ['error', false],
      expectedCode: 'REVIEW_REWORK_SPENT',
    },
    {
      name: 'a Critical outside the rework fix delta blocks with the ledger',
      input: inputFor([...reworkOutside.rounds, reworkOutsideFix], fixtureProjectConfig(), { findingAnnotations: outsideAnnotations }),
      expected: ['block', false],
      expectedCode: 'POLICY_DENIED',
    },
    {
      name: 'a Critical outside the delta of the round after the re-plan blocks with the ledger',
      input: inputFor([...replanOutside.rounds, ...replanOutsideRounds], fixtureProjectConfig(), { findingAnnotations: outsideAnnotations }),
      expected: ['block', false],
      expectedCode: 'POLICY_DENIED',
    },
    {
      name: 'the re-plan round reviews the complete artifact',
      input: inputFor([...replanDelta.rounds, replanDeltaRound]),
      expected: ['error', false],
      expectedGap: 're-plan round',
    },
    {
      name: 'a Critical first seen in the re-plan round is fixed in one more round',
      input: inputFor([...replanCritical.rounds, replanStillCritical], fixtureProjectConfig(), { scope: 'full' }),
      expected: ['continue', false],
      expectedCode: 'REVIEW_FIX_DELTA_REQUIRED',
    },
    {
      name: 'the fix round after the re-plan round closes on a full round',
      input: inputFor([...replanCritical.rounds, replanStillCritical, replanCriticalFixed]),
      expected: ['continue', false],
      expectedCode: 'REVIEW_FULL_CLOSE_REQUIRED',
    },
    {
      name: 'the closing round after the re-plan Critical fix delivers',
      input: inputFor([...replanCritical.rounds, replanStillCritical, replanCriticalFixed, replanCriticalClose], fixtureProjectConfig(), { scope: 'full' }),
      expected: ['clean', true],
      expectedCode: 'REVIEW_CLEAN',
    },
    {
      name: 'a Critical still open after the admitted fix round blocks with the ledger',
      input: inputFor([...replanCriticalOpen.rounds, ...replanCriticalOpenRounds]),
      expected: ['block', false],
      expectedCode: 'POLICY_DENIED',
    },
    {
      name: 'a second fix round after the re-plan round is refused',
      input: inputFor([...replanCriticalOpen.rounds, ...replanCriticalOpenRounds, replanCriticalSecondFix]),
      expected: ['error', false],
      expectedCode: 'REVIEW_REPLAN_SPENT',
    },
    {
      name: 'a Major first seen in the re-plan round may be deferred outside the seam in the closing round',
      input: inputFor([...replanDefer.rounds, ...replanDeferRounds], fixtureProjectConfig(), { scope: 'full' }),
      expected: ['clean', true],
      expectedCode: 'REVIEW_CLEAN',
    },
    {
      name: 'a verified Critical past the budget is still fixed in the next round',
      input: inputFor(lateCritical.rounds),
      expected: ['continue', false],
      expectedCode: 'REVIEW_FIX_DELTA_REQUIRED',
    },
    {
      name: 'the Critical fix round past the budget is accepted',
      input: inputFor([...lateCritical.rounds, lateCriticalFixed]),
      expected: ['continue', false],
      expectedCode: 'REVIEW_FULL_CLOSE_REQUIRED',
    },
    {
      name: 'once the budget is spent a Major raised only once may be deferred',
      input: inputFor(lateMajorRounds, fixtureProjectConfig(), { scope: 'full' }),
      expected: ['clean', true],
    },
    {
      name: 'Minors never consume the budget and never hold delivery',
      input: inputFor(minorOnly.rounds),
      expected: ['continue', false],
      expectedCode: 'REVIEW_FULL_CLOSE_REQUIRED',
    },
    {
      name: 'a closing round that finds only Minors delivers',
      input: inputFor([...minorOnly.rounds, minorClose], fixtureProjectConfig(), { scope: 'full' }),
      expected: ['clean', true],
    },
    {
      name: 'a Major re-filed under a new id on the same predicate keeps its raisings',
      input: refiledInput,
      expected: ['clean', true],
    },
    {
      name: 'the caller cannot configure the review cap',
      input: {
        ...inputFor([acceptedFirst]),
        projectConfig: {
          ...fixtureProjectConfig(),
          caps: { codeReviewRoundsPerUnit: 50 },
        },
      },
      expected: ['error', false],
    },
    {
      name: 'there is no caller-authored rebut status input field',
      input: {
        ...inputFor([rejectedFirst, rejected]),
        rebutRequests: [{ findingId: finding.id, status: 'accepted' }],
      },
      expected: ['error', false],
    },
    {
      name: 'a later delta must start at the preceding reviewed head',
      input: inputFor([wrongDeltaFirst, wrongDelta]),
      expected: ['error', false],
    },
    {
      name: 'a later-round ledger cannot omit a prior Major',
      input: inputFor([omittedLedgerFirst, omittedLedger]),
      expected: ['error', false],
    },
    {
      name: 'review rounds require distinct reviewer dispatches',
      input: inputFor([reusedFirst, reused]),
      expected: ['error', false],
    },
    {
      name: 'review history cannot switch repositories',
      input: inputFor([switchedFirst, switched]),
      expected: ['error', false],
    },
    {
      name: 'a reviewer identity equal to the author is not an independent review',
      input: inputFor([collided]),
      expected: ['error', false],
    },

    {
      name: 'three rounds retain closed and open cumulative findings',
      input: inputFor(
        [cumulativeFirst, cumulativeSecond, cumulativeThird],
        fixtureProjectConfig(),
        { scope: 'full' },
      ),
      expected: ['clean', true],
    },
    {
      name: 'three rounds cannot omit a resolved historical finding',
      input: inputFor([omittedHistoryFirst, omittedHistorySecond, omittedHistoryThird]),
      expected: ['error', false],
    },
    {
      name: 'three rounds cannot rewrite historical finding evidence',
      input: inputFor([mutatedFirst, mutatedSecond, mutatedThird]),
      expected: ['error', false],
    },
    {
      // Without a broker signature a caller can author a verdict, so the
      // remaining defence is internal consistency: a "pass" that still carries
      // a gating finding, or a rebut whose status contradicts the findings, is
      // refused. Attribution now comes from the dispatch record, not a seal.
      name: 'a pass verdict that still carries a gating finding is refused',
      input: (() => {
        const forged = structuredClone(acceptedFirst);
        forged.verdict.verdict = 'pass';
        return inputFor([forged]);
      })(),
      expected: ['error', false],
    },
    {
      name: 'a stale expected head cannot replay an authentic round',
      input: {
        ...inputFor([clean]),
        expected: { ...inputFor([clean]).expected, headOid: 'f'.repeat(40) },
      },
      expected: ['error', false],
    },
    {
      name: 'a stale expected repository cannot replay an authentic round',
      input: {
        ...inputFor([clean]),
        expected: {
          ...inputFor([clean]).expected,
          repositoryFingerprint: 'f'.repeat(64),
        },
      },
      expected: ['error', false],
    },
    {
      name: 'round history cannot skip a review round',
      input: {
        ...inputFor([acceptedFirst, accepted]),
        reviewRounds: [accepted],
      },
      expected: ['error', false],
    },
    {
      name: 'round one cannot claim delta scope',
      input: { ...inputFor([clean]), scope: 'delta' },
      expected: ['error', false],
    },
    {
      name: 'a null finding annotation is rejected without throwing',
      input: { ...inputFor([clean]), findingAnnotations: [null] },
      expected: ['error', false],
    },
    {
      name: 'a full review cannot classify a finding out of scope',
      input: (() => {
        const failing = roundFactory(fixtureProjectConfig(), { seed: 'full-scope' })(
          1,
          failWith([{
            id: 'full-major',
            severity: 'Major',
            summary: 'A full-review finding',
            evidence: 'src/reviewed.mjs:4',
          }]),
        );
        const standalone = inputFor([failing]);
        standalone.findingAnnotations[0].inScope = false;
        return standalone;
      })(),
      expected: ['error', false],
    },
    {
      name: 'a config whose fingerprint does not bind the rounds is rejected',
      input: {
        ...inputFor([clean]),
        projectConfig: { ...fixtureProjectConfig(), baseBranch: 'trunk' },
      },
      expected: ['error', false],
    },
    {
      // A dirty checkout still converges the REVIEW; it is publication that
      // requires a clean live checkout, which authorizeReviewPublication below
      // enforces separately.
      name: 'a dirty reviewed checkout still converges the review itself',
      input: (() => {
        const dirty = structuredClone(clean);
        dirty.checkout.clean = false;
        return inputFor([dirty]);
      })(),
      expected: ['clean', true],
    },
  ];

  // v0.55.0 review: a review chain started before setup migrated STATE
  // carries its 0.27.0 config in every round's fingerprint. It continues on
  // that config (valid at a migratable version) instead of failing input
  // validation mid-unit.
  const chainConfig027 = {
    ...fixtureProjectConfig(),
    version: '0.27.0',
    caps: { gateRetriesPerUnit: 2, codeReviewRoundsPerUnit: 5, sliceMaxLines: 700, sliceMaxFiles: 10 },
  };
  cases.push({
    name: 'a review chain started under a migratable schema continues',
    input: inputFor([roundFactory(chainConfig027, { seed: 'schema-027' })(1, failWith([finding]))], chainConfig027),
    expected: ['continue', false],
    expectedCode: 'REVIEW_FIX_DELTA_REQUIRED',
  });
  // Global install: round 1's projectConfig must equal prime's resolved one
  // (defaults filled, older schemas migrated), or the fingerprint breaks.
  const reviewConfigCheck = (() => {
    const root = mkdtempSync(join(tmpdir(), 'review-config-'));
    try {
      mkdirSync(join(root, '.autoloop'));
      const jsonPath = join(root, '.autoloop', 'config.json');
      writeFileSync(jsonPath, JSON.stringify({ ...chainConfig027 }));
      const migrated = projectConfigForReview(jsonPath);
      writeFileSync(jsonPath, JSON.stringify({ version: '0.28.0', baseBranch: 'trunk', gate: { command: 'x' } }));
      mkdirSync(join(root, 'docs', 'agentic'), { recursive: true });
      // SPEC-model-config: routing is not reviewed policy. A project with a
      // model table fingerprints exactly as prime hands it over, without it.
      const withModels = { version: '0.28.0', baseBranch: 'trunk', gate: { command: 'x' }, models: { implement: { effort: 'high' } } };
      writeFileSync(jsonPath, JSON.stringify(withModels));
      const reviewed = projectConfigForReview(jsonPath);
      const modelsLeftOut = reviewed.models === undefined
        && hashValue(reviewed) === hashValue(reviewedConfig(resolveProjectConfig(root).config));
      writeFileSync(jsonPath, JSON.stringify({ version: '0.28.0', baseBranch: 'trunk', gate: { command: 'x' } }));
      return modelsLeftOut && migrated.version === '0.28.0' && migrated.caps === undefined
        && projectConfigForReview(jsonPath).baseBranch === 'trunk'
        && projectConfigForReview(jsonPath).merge.policy === 'manual'
        // Beside the real STATE, so a root derived from it WOULD find config.
        // `.autoloop/STATE.md` is prose, and three levels up is the parent.
        && ['', join(root, 'docs', 'agentic', 'STATE.md'), join(root, '.autoloop', 'STATE.md'),
          join(root, 'elsewhere', 'config.json')].every((bad) => {
          try {
            projectConfigForReview(bad);
            return false;
          } catch {
            return true;
          }
        });
    } catch (error) {
      console.error(`round-1 config check threw: ${error.message}`);
      return false;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  })();
  if (!reviewConfigCheck) cases.push({ name: 'round 1 resolves the project config like prime', input: null, expected: ['never', false] });
  const respelledCheck = !validReviewRound(respelled)
    && validReviewRound({ ...respelled, reviewerIdentity: 'claude:gpt-6-astra[1m]' });
  if (!respelledCheck) cases.push({ name: 'the writer\'s model spelled another way is not an independent reviewer', input: null, expected: ['never', false] });

  cases.push(
    {
      name: 'a delta round covering the widened paths continues to the closing full round',
      input: inputFor([widenFirst, widenCovered]),
      expected: ['continue', false],
      expectedCode: 'REVIEW_FULL_CLOSE_REQUIRED',
    },
    {
      name: 'a delta round that omits a widened path is refused REVIEW_DELTA_SCOPE_INCOMPLETE',
      input: inputFor([uncoveredFirst, widenUncovered]),
      expected: ['error', false],
      expectedCode: 'REVIEW_DELTA_SCOPE_INCOMPLETE',
      expectedGap: 'lib/',
    },
    {
      name: 'a widen ledger entry without paths is not valid evidence',
      input: (() => {
        const rounds = structuredClone([widenFirst, widenCovered]);
        delete rounds[1].priorFindings[0].paths;
        return inputFor(rounds);
      })(),
      expected: ['error', false],
      expectedCode: 'INVALID_REVIEW_EVIDENCE',
    },
  );

  let passed = 0;
  for (const fixture of cases) {
    const actual = reviewTransition(fixture.input);
    if (
      actual.state !== fixture.expected[0]
      || actual.publishReviewSuccess !== fixture.expected[1]
    ) {
      console.error(
        `FAIL ${fixture.name}: expected ${fixture.expected.join('/')}, `
        + `got ${actual.state}/${actual.publishReviewSuccess} (${actual.code})`,
      );
      continue;
    }
    if (fixture.expectedCode !== undefined && actual.code !== fixture.expectedCode) {
      console.error(
        `FAIL ${fixture.name}: expected code ${fixture.expectedCode}, `
        + `got ${actual.code}`,
      );
      continue;
    }
    if (
      fixture.expectedGap !== undefined
      && !String(actual.evidenceGap ?? '').includes(fixture.expectedGap)
    ) {
      console.error(
        `FAIL ${fixture.name}: expected an evidenceGap naming `
        + `"${fixture.expectedGap}", got ${actual.evidenceGap ?? '<none>'}`,
      );
      continue;
    }
    passed += 1;
  }

  const deltaClose = inputFor([mismatchFirst, mismatchDelta]);
  const passResult = { ok: true, role: 'code-review', verdict: pass };
  const appended = appendEscalationRound(deltaClose, passResult, {
    dispatchId: 'dispatch-escalation',
  });
  const appendCases = [
    {
      name: 'appending the closing round to a clean delta converges the review',
      actual: appended.ok === true
        && appended.code === 'REVIEW_CLEAN'
        && appended.evidence.round === 3
        && appended.evidence.scope === 'full'
        && appended.evidence.reviewRounds.length === 3
        && reviewTransition(appended.evidence).state === 'clean',
      expected: true,
    },
    {
      name: 'the appended round inherits the reviewed artifact and widens only its scope',
      actual: (() => {
        const [, previous, closing] = appended.evidence.reviewRounds;
        return closing.scope === 'full-artifact'
          && closing.headOid === previous.headOid
          && closing.artifactFingerprint === previous.artifactFingerprint
          && closing.artifactVersion === previous.artifactVersion
          && closing.deltaBaseOid === previous.headOid
          && closing.dispatchId !== previous.dispatchId;
      })(),
      expected: true,
    },
    {
      name: 'a review that is not awaiting its full close is refused',
      actual: appendEscalationRound(appended.evidence, passResult, {
        dispatchId: 'dispatch-again',
      }).code,
      expected: 'NOT_AWAITING_FULL_CLOSE',
    },
    {
      name: 'a closing verdict carrying rebuts is refused',
      actual: appendEscalationRound(deltaClose, {
        ok: true,
        role: 'code-review',
        verdict: { verdict: 'pass', findings: [], rebuts: [accept(finding.id, 'Closed.')] },
      }, { dispatchId: 'dispatch-rebut' }).code,
      expected: 'ESCALATION_ROUND_CANNOT_REBUT',
    },
    {
      name: 'a tool may not stamp a finding verified',
      actual: appendEscalationRound(deltaClose, {
        ok: true,
        role: 'code-review',
        verdict: failWith([lateFinding]),
      }, { dispatchId: 'dispatch-late' }).code,
      expected: 'FINDING_ANNOTATIONS_REQUIRED',
    },
    {
      name: 'a replayed dispatch id is caught before the evidence is returned',
      actual: appendEscalationRound(deltaClose, passResult, {
        dispatchId: mismatchDelta.dispatchId,
      }).ok,
      expected: false,
    },
    {
      name: 'a failed dispatch is not a round',
      actual: appendEscalationRound(deltaClose, { ok: false }, {
        dispatchId: 'dispatch-dead',
      }).code,
      expected: 'INVALID_DISPATCH_RESULT',
    },
  ];

  // `--append-round`: every ordinary round built by the tool from the dispatch
  // result, the checkout, and the orchestrator's dispositions — the shapes a
  // live run improvised in /tmp and the permission classifier refused.
  const builderCheckout = (head) => ({
    root: '/fixture/repo',
    repositoryFingerprint: hash('repo-builder'),
    branch: 'loop/issue-9',
    headOid: oid(head),
    clean: true,
  });
  const builderFirst = {
    projectConfig: fixtureProjectConfig(),
    planFingerprint: hash('plan-builder'),
    authorIdentity: 'claude:claude-opus-5-5',
    configuredBaseOid: oid('base-builder'),
    boundary: ['src/'],
  };
  const reviewed = (verdict) => ({
    ok: true, role: 'code-review', engine: 'claude', model: 'gpt-6-astra', verdict,
  });
  const verifiedIn = (id) => ({ id, verified: true, inScope: true });
  const builtFirst = appendRound(null, reviewed(failWith([finding])), {
    first: builderFirst,
    scope: 'full',
    checkout: builderCheckout('b-1'),
    artifactFingerprint: hash('tree-1'),
    dispatchId: 'builder-1',
    findingAnnotations: [verifiedIn(finding.id)],
  });
  const secondOptions = (overrides = {}) => ({
    scope: 'delta',
    checkout: builderCheckout('b-2'),
    artifactFingerprint: hash('tree-2'),
    dispatchId: 'builder-2',
    findingAnnotations: [],
    dispositions: [{
      findingId: finding.id, disposition: 'fix', rationale: 'Fixed in the delta.',
    }],
    ...overrides,
  });
  const builtSecond = builtFirst.ok
    ? appendRound(builtFirst.evidence, reviewed(pass), secondOptions())
    : { ok: false };
  const rebutOptions = secondOptions({
    dispositions: [{
      findingId: finding.id,
      disposition: 'rebut',
      rationale: 'The finding misreads the invariant.',
      claim: 'The guard already covers this path.',
      evidence: 'src/reviewed.mjs:9 checks it first.',
    }],
  });
  const builderCases = [
    {
      name: 'the first round is built whole from the result and the checkout',
      actual: builtFirst.ok === true
        && builtFirst.code === 'REVIEW_FIX_DELTA_REQUIRED'
        && reviewTransition(builtFirst.evidence).state === 'continue'
        && builtFirst.evidence.reviewRounds[0].reviewerIdentity === 'claude:gpt-6-astra'
        && builtFirst.evidence.reviewRounds[0].deltaBaseOid === builderFirst.configuredBaseOid
        && builtFirst.evidence.reviewRounds[0].configFingerprint
          === hashValue(builderFirst.projectConfig),
      expected: true,
    },
    {
      name: 'a fixed finding is carried open into the next round and the delta closes clean',
      actual: builtSecond.ok === true
        && builtSecond.code === 'REVIEW_FULL_CLOSE_REQUIRED'
        && builtSecond.evidence.reviewRounds[1].artifactVersion === 2
        && builtSecond.evidence.reviewRounds[1].deltaBaseOid === oid('b-1')
        && builtSecond.evidence.reviewRounds[1].priorFindings[0].disposition === 'fix'
        && builtSecond.evidence.reviewRounds[1].priorFindings[0].state === 'open',
      expected: true,
    },
    {
      name: 'the built chain hands off to the escalation round and converges',
      actual: builtSecond.ok === true
        && appendEscalationRound(builtSecond.evidence, reviewed(pass), {
          dispatchId: 'builder-3',
        }).code === 'REVIEW_CLEAN',
      expected: true,
    },
    {
      name: 'a gating finding from the previous round needs a disposition',
      actual: builtFirst.ok
        ? appendRound(builtFirst.evidence, reviewed(pass), secondOptions({ dispositions: [] })).code
        : null,
      expected: 'DISPOSITION_REQUIRED',
    },
    {
      name: 'a rebut disposition becomes the round\'s open rebuttal',
      actual: (() => {
        if (!builtFirst.ok) return false;
        const built = appendRound(
          builtFirst.evidence,
          reviewed(failWith([finding], [reject(finding.id, 'Still reproduces.')])),
          { ...rebutOptions, findingAnnotations: [verifiedIn(finding.id)] },
        );
        return built.ok === true
          && built.evidence.reviewRounds[1].openRebuttals[0].claim
            === 'The guard already covers this path.'
          && built.evidence.reviewRounds[1].priorFindings[0].disposition === 'rebut';
      })(),
      expected: true,
    },
    {
      name: 'a recurring Major is deferred by disposition and stays deferred when re-raised',
      actual: (() => {
        if (!builtFirst.ok) return false;
        let evidence = builtFirst.evidence;
        const next = (round, disposition, scope = 'delta') => appendRound(
          evidence,
          reviewed(failWith([finding])),
          {
            scope,
            checkout: builderCheckout(`recur-${round}`),
            artifactFingerprint: hash(`recur-tree-${round}`),
            dispatchId: `recur-${round}`,
            findingAnnotations: [verifiedIn(finding.id)],
            dispositions: disposition === null ? [] : [{
              findingId: finding.id, disposition, rationale: disposition === 'defer'
                ? 'Filed as follow-up #123; listed in the PR body.'
                : 'Fixed again.',
            }],
          },
        );
        for (const round of [2, 3]) {
          const built = next(round, 'fix');
          if (built.ok !== true) return false;
          evidence = built.evidence;
        }
        const fourth = appendRound(evidence, reviewed(failWith([finding])), {
          scope: 'delta',
          checkout: builderCheckout('recur-4'),
          artifactFingerprint: hash('recur-tree-4'),
          dispatchId: 'recur-4',
          findingAnnotations: [verifiedIn(finding.id)],
          dispositions: [{ findingId: finding.id, disposition: 'defer', rationale: 'Later.' }],
        });
        const deferred = next(4, 'defer', 'full');
        if (deferred.ok !== true) return false;
        evidence = deferred.evidence;
        // Round 5 re-raises it with no disposition given: the deferral carries.
        const carried = next(5, null, 'full');
        return fourth.ok === false
          && deferred.code === 'REVIEW_CLEAN'
          && reviewTransition(deferred.evidence).deferredFindings?.[0]?.findingId === finding.id
          && carried.ok === true && carried.code === 'REVIEW_CLEAN'
          && carried.evidence.reviewRounds[4].priorFindings
            .find(({ findingId }) => findingId === finding.id)?.disposition === 'defer';
      })(),
      expected: true,
    },
    {
      // SPEC-review-rounds, through the builder: three fix rounds, a fourth
      // refused by name, one re-plan round with its new plan, the ledger
      // keyed by the predicate the orchestrator annotated.
      name: 'the builder refuses a fourth fix round and accepts one re-plan round with its new plan',
      actual: (() => {
        if (!builtFirst.ok) return false;
        let evidence = builtFirst.evidence;
        const next = (round, options) => appendRound(evidence, reviewed(failWith([finding])), {
          scope: 'delta',
          checkout: builderCheckout(`budget-${round}`),
          artifactFingerprint: hash(`budget-tree-${round}`),
          dispatchId: `budget-${round}`,
          findingAnnotations: [{ ...verifiedIn(finding.id), predicate: 'rule:gate' }],
          dispositions: [{ findingId: finding.id, disposition: 'fix', rationale: 'Fixed again.' }],
          ...options,
        });
        for (const round of [2, 3, 4]) {
          const built = next(round, {});
          if (built.ok !== true) return false;
          evidence = built.evidence;
        }
        const spentCode = reviewTransition(evidence).code;
        const fourth = next(5, {});
        const replanDelta = next(5, { planFingerprint: hash('plan-builder-v2') });
        const replan = next(5, { scope: 'full', planFingerprint: hash('plan-builder-v2') });
        if (replan.ok !== true) return false;
        const again = appendRound(replan.evidence, reviewed(pass), {
          scope: 'full',
          checkout: builderCheckout('budget-6'),
          artifactFingerprint: hash('budget-tree-6'),
          dispatchId: 'budget-6',
          findingAnnotations: [],
          dispositions: [{ findingId: finding.id, disposition: 'fix', rationale: 'Once more.' }],
          planFingerprint: hash('plan-builder-v3'),
        });
        return spentCode === 'REVIEW_REPLAN'
          && fourth.ok === false && fourth.code === 'REVIEW_FIX_BUDGET_SPENT'
          && replanDelta.ok === false && replanDelta.code === 'INVALID_SCOPE'
          && replan.code === 'REVIEW_OPEN_FINDINGS'
          && replan.evidence.reviewRounds[4].planFingerprint === hash('plan-builder-v2')
          && replan.evidence.reviewRounds[4].priorFindings.at(-1).predicate === 'rule:gate'
          && reviewTransition(replan.evidence).openFindings[0].raisings === 5
          && again.ok === false && again.code === 'REVIEW_REPLAN_SPENT';
      })(),
      expected: true,
    },
    {
      // SPEC-review-rounds §5a, through the builder: the hand-off names its
      // round and evidence; a rework bound to them admits one fix round,
      // which the closing round inherits; a stale or foreign one is refused.
      name: 'the builder admits an authorized rework after the hand-off and carries it to the closing round',
      actual: (() => {
        if (!builtFirst.ok) return false;
        let evidence = builtFirst.evidence;
        const next = (round, options) => appendRound(evidence, reviewed(failWith([finding])), {
          scope: 'delta',
          checkout: builderCheckout(`rework-${round}`),
          artifactFingerprint: hash(`rework-tree-${round}`),
          dispatchId: `rework-${round}`,
          findingAnnotations: [{ ...verifiedIn(finding.id), predicate: 'rule:gate' }],
          dispositions: [{ findingId: finding.id, disposition: 'fix', rationale: 'Fixed again.' }],
          ...options,
        });
        for (const round of [2, 3, 4]) {
          const built = next(round, {});
          if (built.ok !== true) return false;
          evidence = built.evidence;
        }
        const handoff = next(5, { scope: 'full', planFingerprint: hash('plan-rework-v2') });
        if (handoff.code !== 'REVIEW_OPEN_FINDINGS') return false;
        const transition = reviewTransition(handoff.evidence);
        const grant = {
          kind: 'answer', issue: 1, comment: 'https://example.test/acme/widgets/issues/1#issuecomment-88',
          round: transition.round, evidenceFingerprint: transition.reviewEvidenceFingerprint,
        };
        const fix = (options) => appendRound(handoff.evidence, reviewed(pass), {
          scope: 'delta',
          checkout: builderCheckout('rework-6'),
          artifactFingerprint: hash('rework-tree-6'),
          dispatchId: 'rework-6',
          findingAnnotations: [],
          dispositions: [{ findingId: finding.id, disposition: 'fix', rationale: 'Reworked.' }],
          ...options,
        });
        const foreign = fix({ reworkAuthorization: { ...grant, evidenceFingerprint: hash('another hand-off') } });
        const otherRound = fix({ reworkAuthorization: { ...grant, round: 4 } });
        const notHandoff = appendRound(builtFirst.evidence, reviewed(pass), {
          scope: 'delta', checkout: builderCheckout('rework-early'), artifactFingerprint: hash('rework-early'), dispatchId: 'rework-early',
          findingAnnotations: [], dispositions: [{ findingId: finding.id, disposition: 'fix', rationale: 'Fixed.' }],
          reworkAuthorization: { ...grant, round: 1, evidenceFingerprint: hashValue(builtFirst.evidence.reviewRounds[0]) },
        });
        const fixed = fix({ reworkAuthorization: grant });
        if (fixed.ok !== true) return false;
        const closed = appendEscalationRound(fixed.evidence, reviewed(pass), { dispatchId: 'rework-7' });
        if (closed.ok !== true) return false;
        const last = closed.evidence.reviewRounds.at(-1);
        const published = authorizeReviewPublication(closed.evidence, last.headOid, last.checkout);
        const past = appendRound(closed.evidence, reviewed(pass), {
          scope: 'full',
          checkout: builderCheckout('rework-6'),
          artifactFingerprint: hash('rework-tree-6'),
          dispatchId: 'rework-8',
          findingAnnotations: [],
        });
        return transition.round === 5
          && transition.reviewEvidenceFingerprint === hashValue(handoff.evidence.reviewRounds.at(-1))
          && foreign.ok === false && foreign.code === 'REWORK_NOT_AUTHORIZABLE'
          && otherRound.ok === false && otherRound.code === 'REWORK_NOT_AUTHORIZABLE'
          && notHandoff.ok === false && notHandoff.code === 'REWORK_NOT_AUTHORIZABLE'
          && fixed.code === 'REVIEW_FULL_CLOSE_REQUIRED'
          && JSON.stringify(fixed.evidence.reviewRounds.at(-1).reworkAuthorization) === JSON.stringify(grant)
          && closed.code === 'REVIEW_CLEAN'
          && JSON.stringify(last.reworkAuthorization) === JSON.stringify(grant)
          && published.authorized === true
          && JSON.stringify(published.reworkAuthorizations) === JSON.stringify([grant])
          && past.ok === false && past.code === 'REVIEW_REWORK_SPENT';
      })(),
      expected: true,
    },
    {
      name: 'a round over the same artifact keeps its version, so a decision needs no commit',
      actual: (() => {
        if (!builtFirst.ok) return false;
        const decided = appendRound(builtFirst.evidence, reviewed({
          verdict: 'pass', findings: [], rebuts: [accept(finding.id, 'Agreed.')],
        }), {
          ...rebutOptions,
          scope: 'full',
          checkout: builderCheckout('b-1'),
          artifactFingerprint: hash('tree-1'),
        });
        return decided.ok === true
          && decided.code === 'REVIEW_CLEAN'
          && decided.evidence.reviewRounds[1].artifactVersion === 1;
      })(),
      expected: true,
    },
    {
      // SPEC-elastic-scope: a verified finding whose fix is one directory
      // away is fixed in the unit; the widening is the record.
      name: 'a widen disposition adds its paths to the evidence boundary, the delta covers them, and the close lists the scope change',
      actual: (() => {
        if (!builtFirst.ok) return false;
        const widen = (overrides = {}) => appendRound(builtFirst.evidence, reviewed(pass), secondOptions({
          deltaPaths: ['src/reviewed.mjs', 'lib/b.mjs'],
          dispositions: [{
            findingId: finding.id, disposition: 'widen', paths: ['lib/b.mjs'],
            rationale: 'The guard lives in lib/b.mjs; the finding is verified there.',
          }],
          ...overrides,
        }));
        const widened = widen();
        if (widened.ok !== true) return false;
        const closed = appendEscalationRound(widened.evidence, reviewed(pass), { dispatchId: 'builder-widen-3' });
        const transition = closed.ok ? reviewTransition(closed.evidence) : null;
        return widened.code === 'REVIEW_FULL_CLOSE_REQUIRED'
          && JSON.stringify(widened.evidence.boundary) === '["src/","lib/b.mjs"]'
          && widened.evidence.reviewRounds[1].priorFindings[0].disposition === 'widen'
          && JSON.stringify(widened.evidence.reviewRounds[1].priorFindings[0].paths) === '["lib/b.mjs"]'
          && widened.evidence.reviewRounds[1].artifactVersion === 2
          && widen({ deltaPaths: ['src/reviewed.mjs'] }).code === 'REVIEW_DELTA_SCOPE_INCOMPLETE'
          && widen({ scope: 'full' }).ok === true
          && closed.code === 'REVIEW_CLEAN'
          && JSON.stringify(transition.scopeChanges)
            === JSON.stringify([{ findingId: finding.id, paths: ['lib/b.mjs'], rationale: 'The guard lives in lib/b.mjs; the finding is verified there.' }]);
      })(),
      expected: true,
    },
    {
      name: 'a widen without a verified finding, without paths, or into a secret path is refused',
      actual: (() => {
        if (!builtFirst.ok) return false;
        const widen = (disposition, evidence = builtFirst.evidence) => appendRound(evidence, reviewed(pass), secondOptions({
          deltaPaths: ['src/reviewed.mjs', 'lib/b.mjs', '.env'],
          dispositions: [{ findingId: finding.id, disposition: 'widen', rationale: 'Widen.', ...disposition }],
        })).code;
        const unverified = structuredClone(builtFirst.evidence);
        unverified.findingAnnotations[0].verified = false;
        return widen({ paths: [] }) === 'WIDEN_PATHS_REQUIRED'
          && widen({}) === 'WIDEN_PATHS_REQUIRED'
          && widen({ paths: ['.env'] }) === 'WIDEN_SECRET_PATH'
          && widen({ paths: ['../lib/b.mjs'] }) === 'WIDEN_PATH_INVALID'
          && widen({ paths: ['lib/b.mjs'] }, unverified) === 'WIDEN_UNVERIFIED_FINDING';
      })(),
      expected: true,
    },
    {
      name: 'a widening into a protected path labels human:authorize and does not refuse',
      actual: (() => {
        if (!builtFirst.ok) return false;
        const widened = appendRound(builtFirst.evidence, reviewed(pass), secondOptions({
          deltaPaths: ['.github/workflows/ci.yml'],
          dispositions: [{
            findingId: finding.id, disposition: 'widen', paths: ['.github/workflows/ci.yml'], rationale: 'The job name is wrong.',
          }],
        }));
        return widened.ok === true
          && JSON.stringify(widened.authorize) === '[{"file":".github/workflows/ci.yml","glob":".github/workflows/**"}]';
      })(),
      expected: true,
    },
    {
      // The implementer's own widening: a plan task that cannot pass its
      // test without a path outside the boundary, recorded before round 1.
      name: 'an implement result listing extra paths is recorded as widenings before round 1',
      actual: (() => {
        const implemented = (extraPaths) => ({ ok: true, role: 'implement', text: 'done', ...(extraPaths === undefined ? {} : { extraPaths }) });
        const recorded = widenFromImplementer(implemented([
          { path: 'lib/shared.mjs', reason: 'task 2 cannot pass its test without the helper' },
          { path: 'src/inside.mjs', reason: 'already inside' },
        ]), ['src/']);
        if (recorded.ok !== true) return false;
        const first = appendRound(null, reviewed(failWith([finding])), {
          first: { ...builderFirst, boundary: recorded.boundary, scopeChanges: recorded.scopeChanges },
          scope: 'full',
          checkout: builderCheckout('b-widen-1'),
          artifactFingerprint: hash('tree-widen-1'),
          dispatchId: 'builder-widen-1',
          findingAnnotations: [verifiedIn(finding.id)],
        });
        return JSON.stringify(recorded.boundary) === '["src/","lib/shared.mjs"]'
          && JSON.stringify(recorded.scopeChanges)
            === JSON.stringify([{ findingId: 'implement:extra-1', paths: ['lib/shared.mjs'], rationale: 'task 2 cannot pass its test without the helper' }])
          && widenFromImplementer(implemented(undefined), ['src/']).scopeChanges.length === 0
          && widenFromImplementer(implemented([{ path: '.env.local', reason: 'r' }]), ['src/']).code === 'WIDEN_SECRET_PATH'
          && widenFromImplementer({ ok: false }, ['src/']).code === 'INVALID_DISPATCH_RESULT'
          && first.ok === true
          && JSON.stringify(first.evidence.boundary) === '["src/","lib/shared.mjs"]'
          && first.evidence.scopeChanges.length === 1
          && reviewTransition(first.evidence).code === 'REVIEW_FIX_DELTA_REQUIRED';
      })(),
      expected: true,
    },
    {
      // The seam test decides widen or defer: another top-level package or
      // service directory, or a path the plan names out of scope, is a repair.
      name: 'a finding outside the seam is deferred to a repair at any round; one inside it is widened',
      actual: (() => {
        if (!builtFirst.ok) return false;
        const plan = { boundary: ['services/orders/api.mjs', 'src/api/'], outOfScope: ['docs/'] };
        const seam = outsideSeam('services/billing/x.mjs', plan) === true
          && outsideSeam('services/orders/lib/y.mjs', plan) === false
          && outsideSeam('src/util/x.mjs', plan) === false
          && outsideSeam('lib/x.mjs', plan) === true
          && outsideSeam('docs/x.md', plan) === true
          && outsideSeam('package.json', plan) === false
          && outsideSeam('packages/a/x.mjs', { boundary: ['packages/b/'] }) === true
          && outsideSeam('packages/b/x.mjs', { boundary: ['packages/b/y.mjs'] }) === false;
        const defer = (seamName) => appendRound(builtFirst.evidence, reviewed(pass), secondOptions({
          scope: 'full',
          checkout: builderCheckout('b-1'),
          artifactFingerprint: hash('tree-1'),
          dispositions: [{
            findingId: finding.id, disposition: 'defer', rationale: 'Filed as follow-up #77.',
            ...(seamName === undefined ? {} : { seam: seamName }),
          }],
        }));
        const deferred = defer('services/billing');
        // Re-raised by the next reviewer, the deferral carries with its seam.
        const reraised = appendRound(builtFirst.evidence, reviewed(failWith([finding])), secondOptions({
          scope: 'full',
          checkout: builderCheckout('b-1'),
          artifactFingerprint: hash('tree-1'),
          findingAnnotations: [verifiedIn(finding.id)],
          dispositions: [{ findingId: finding.id, disposition: 'defer', rationale: 'Filed as follow-up #77.', seam: 'services/billing' }],
        }));
        const carried = reraised.ok !== true ? reraised : appendRound(reraised.evidence, reviewed(pass), {
          scope: 'full', checkout: builderCheckout('b-3'), artifactFingerprint: hash('tree-3'), dispatchId: 'builder-3', findingAnnotations: [],
        });
        const widened = appendRound(builtFirst.evidence, reviewed(pass), secondOptions({
          deltaPaths: ['services/orders/lib/y.mjs'],
          dispositions: [{ findingId: finding.id, disposition: 'widen', paths: ['services/orders/lib/y.mjs'], rationale: 'Inside the seam.' }],
        }));
        return seam
          && deferred.ok === true && deferred.code === 'REVIEW_CLEAN'
          && deferred.evidence.reviewRounds[1].priorFindings[0].seam === 'services/billing'
          && reviewTransition(deferred.evidence).deferredFindings[0].findingId === finding.id
          && carried.ok === true && carried.evidence.reviewRounds[2].priorFindings[0].seam === 'services/billing'
          && defer(undefined).ok === false
          && widened.ok === true && widened.code === 'REVIEW_FULL_CLOSE_REQUIRED';
      })(),
      expected: true,
    },
    {
      name: 'a rebut without its claim and evidence is refused',
      actual: builtFirst.ok
        ? appendRound(builtFirst.evidence, reviewed(pass), secondOptions({
          dispositions: [{ findingId: finding.id, disposition: 'rebut', rationale: 'No.' }],
        })).code
        : null,
      expected: 'REBUTTAL_EVIDENCE_REQUIRED',
    },
    {
      name: 'a dirty checkout is not a reviewable artifact',
      actual: appendRound(null, reviewed(pass), {
        first: builderFirst,
        scope: 'full',
        checkout: { ...builderCheckout('b-dirty'), clean: false },
        artifactFingerprint: hash('tree-dirty'),
        dispatchId: 'builder-dirty',
        findingAnnotations: [],
      }).code,
      expected: 'CHECKOUT_DIRTY',
    },
    {
      name: 'the builder may not stamp a finding verified',
      actual: appendRound(null, reviewed(failWith([finding])), {
        first: builderFirst,
        scope: 'full',
        checkout: builderCheckout('b-unverified'),
        artifactFingerprint: hash('tree-unverified'),
        dispatchId: 'builder-unverified',
        findingAnnotations: [],
      }).code,
      expected: 'FINDING_ANNOTATIONS_REQUIRED',
    },
    {
      name: 'a reviewer stamped with the writer\'s own identity is refused',
      actual: appendRound(null, { ...reviewed(pass), model: 'claude-opus-5-5' }, {
        first: builderFirst,
        scope: 'full',
        checkout: builderCheckout('b-self'),
        artifactFingerprint: hash('tree-self'),
        dispatchId: 'builder-self',
        findingAnnotations: [],
      }).ok,
      expected: false,
    },
    {
      name: 'the artifact fingerprint follows the tree, not the commit',
      actual: (() => {
        const root = mkdtempSync(join(tmpdir(), 'review-contract-tree-'));
        try {
          const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
          git('init', '--quiet');
          git('config', 'user.email', 'fixture@example.invalid');
          git('config', 'user.name', 'fixture');
          writeFileSync(join(root, 'a.txt'), 'one\n');
          git('add', '.');
          git('commit', '--quiet', '-m', 'one');
          const first = artifactFingerprintOf(root);
          git('commit', '--quiet', '--allow-empty', '-m', 'same tree');
          const same = artifactFingerprintOf(root);
          const headBefore = git('rev-parse', 'HEAD').stdout.trim();
          writeFileSync(join(root, 'a.txt'), 'two\n');
          git('commit', '--quiet', '-am', 'two');
          const changed = artifactFingerprintOf(root);
          return HASH_RE.test(first) && first === same && changed !== first
            && JSON.stringify(deltaPathsOf(root, headBefore)) === '["a.txt"]'
            && deltaPathsOf(root, 'f'.repeat(40)) === null;
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      })(),
      expected: true,
    },
    {
      // The CLI on a scratch repository: the first round takes the plan
      // boundary widened by the implementer, a delta round covers a widening
      // only when the fix delta changes the widened path, and three fix rounds
      // then a re-plan round with the Major still open hand the unit off.
      name: 'the append-round CLI builds the widened boundary, covers a widening by the delta, and hands off after the budget',
      actual: (() => {
        const root = mkdtempSync(join(tmpdir(), 'review-contract-cli-'));
        const scratch = mkdtempSync(join(tmpdir(), 'review-contract-cli-in-'));
        try {
          const git = (...args) => {
            const ran = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 15000 });
            if (ran.status !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr}`);
            return ran.stdout.trim();
          };
          const file = (name, body) => {
            mkdirSync(join(root, name, '..'), { recursive: true });
            writeFileSync(join(root, name), body);
          };
          let dispatches = 0;
          const cli = (...args) => {
            dispatches += 1;
            const ran = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--append-round',
              '--dispatch-id', `cli-${dispatches}`, ...args], { cwd: root, encoding: 'utf8', timeout: 15000 });
            try {
              return JSON.parse(ran.stdout);
            } catch {
              return { ok: false, code: 'NO_JSON', stderr: ran.stderr };
            }
          };
          git('init', '--quiet');
          git('config', 'user.email', 'fixture@example.invalid');
          git('config', 'user.name', 'fixture');
          git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
          file('.autoloop/config.json', JSON.stringify(fixtureProjectConfig()));
          file('src/a.mjs', 'one\n');
          git('add', '.');
          git('commit', '--quiet', '-m', 'one');
          const input = (name, value) => {
            writeFileSync(join(scratch, name), JSON.stringify(value));
            return join(scratch, name);
          };
          const failing = input('fail.json', reviewed(failWith([finding])));
          const passing = input('pass.json', reviewed(pass));
          const annotations = input('annotations.json', [verifiedIn(finding.id)]);
          const plan = input('plan.json', { ok: true, plan: { boundary: ['src/'] } });
          const implemented = input('impl.json', { ok: true, extraPaths: [{ path: 'lib/a.mjs', reason: 'task 2 needs the helper' }] });
          const config = join(root, '.autoloop', 'config.json');
          const first = cli('--result-file', failing, '--first-round', '--plan-fingerprint', hash('plan-cli'),
            '--author', 'claude:claude-opus-5-5', '--state', config, '--base-oid', git('rev-parse', 'HEAD'),
            '--boundary-file', plan, '--implement-result-file', implemented, '--annotations-file', annotations,
            '--out', join(scratch, 'ev1.json'));
          const evidence = (name) => JSON.parse(readFileSync(join(scratch, name), 'utf8'));
          const boundaryBuilt = first.ok === true
            && JSON.stringify(evidence('ev1.json').boundary) === JSON.stringify(['src/', 'lib/a.mjs']);
          const widen = input('widen.json', [{ findingId: finding.id, disposition: 'widen', paths: ['lib/b.mjs'], rationale: 'The guard lives in lib.' }]);
          const delta = (out) => cli('--result-file', passing, '--evidence-file', join(scratch, 'ev1.json'),
            '--scope', 'delta', '--dispositions-file', widen, '--out', join(scratch, out));
          file('src/a.mjs', 'elsewhere\n');
          git('commit', '--quiet', '-am', 'a fix that misses the widened path');
          const uncovered = delta('ev-uncovered.json');
          // The widened path, with the round-1 artifact restored beside it, so
          // the delta since round 1 is that path alone.
          file('src/a.mjs', 'one\n');
          file('lib/b.mjs', 'guard\n');
          git('add', '.');
          git('commit', '--quiet', '-m', 'widen');
          const covered = delta('ev2.json');
          const coveredPaths = covered.ok === true
            && JSON.stringify(evidence('ev2.json').reviewRounds[1].deltaPaths) === JSON.stringify(['lib/b.mjs']);
          // Three fix rounds, then a re-plan round the Major survives.
          const fixes = input('fix.json', [{ findingId: finding.id, disposition: 'fix', rationale: 'Fixed in the delta.' }]);
          let last = 'ev1.json';
          const codes = [];
          for (const round of [2, 3, 4]) {
            file('src/a.mjs', `fix ${round}\n`);
            git('commit', '--quiet', '-am', `fix ${round}`);
            const next = `ev-fix-${round}.json`;
            codes.push(cli('--result-file', failing, '--evidence-file', join(scratch, last), '--scope', 'delta',
              '--dispositions-file', fixes, '--annotations-file', annotations, '--out', join(scratch, next)).code);
            last = next;
          }
          file('src/a.mjs', 're-planned\n');
          git('commit', '--quiet', '-am', 're-plan');
          const replan = cli('--result-file', failing, '--evidence-file', join(scratch, last), '--scope', 'full',
            '--plan-fingerprint', hash('plan-cli-v2'), '--dispositions-file', fixes, '--annotations-file', annotations,
            '--out', join(scratch, 'ev-replan.json'));
          // A rework the hand-off admits, through its file.
          const handoff = reviewTransition(evidence('ev-replan.json'));
          const grant = input('rework.json', {
            kind: 'answer', issue: 1, comment: 'https://example.test/acme/widgets/issues/1#issuecomment-88',
            round: handoff.round, evidenceFingerprint: handoff.reviewEvidenceFingerprint,
          });
          file('src/a.mjs', 'reworked\n');
          git('commit', '--quiet', '-am', 'rework');
          const reworked = cli('--result-file', passing, '--evidence-file', join(scratch, 'ev-replan.json'), '--scope', 'delta',
            '--dispositions-file', fixes, '--rework-authorization-file', grant, '--out', join(scratch, 'ev-rework.json'));
          return boundaryBuilt
            && uncovered.ok === false && uncovered.code === 'REVIEW_DELTA_SCOPE_INCOMPLETE'
            && coveredPaths
            && codes.join(',') === 'REVIEW_FIX_DELTA_REQUIRED,REVIEW_FIX_DELTA_REQUIRED,REVIEW_REPLAN'
            && replan.ok === true && replan.code === 'REVIEW_OPEN_FINDINGS'
            && reworked.ok === true && reworked.code === 'REVIEW_FULL_CLOSE_REQUIRED';
        } finally {
          rmSync(root, { recursive: true, force: true });
          rmSync(scratch, { recursive: true, force: true });
        }
      })(),
      expected: true,
    },
  ];

  const cleanInput = inputFor([clean]);
  const openFindingsInput = inputFor(
    [...replanOpen.rounds, replanStillMajor], fixtureProjectConfig(), { scope: 'full' },
  );
  const publicationCases = [
    {
      name: 'a draft hand-off names its open findings with predicate and raisings, and publishes nothing',
      actual: (() => {
        const authorization = authorizeReviewPublication(
          openFindingsInput,
          replanStillMajor.headOid,
          replanStillMajor.checkout,
        );
        const transition = reviewTransition(openFindingsInput);
        return authorization.authorized === false
          && authorization.code === 'REVIEW_OPEN_FINDINGS'
          && transition.reviewedHead === replanStillMajor.headOid
          && transition.fixRounds.used === 3
          && JSON.stringify(transition.openFindings.map(({ id, severity, predicate, raisings }) =>
            ({ id, severity, predicate, raisings })))
            === JSON.stringify([{ id: replanOpen.major.id, severity: 'Major', predicate: replanOpen.major.id, raisings: 5 }]);
      })(),
      expected: true,
    },
    {
      name: 'a clean round authorizes only its reviewed head',
      actual: authorizeReviewPublication(cleanInput, clean.headOid, clean.checkout)
        .authorized,
      expected: true,
    },
    {
      name: 'a clean round cannot authorize a different current head',
      actual: authorizeReviewPublication(cleanInput, 'f'.repeat(40), clean.checkout)
        .authorized,
      expected: false,
    },
    {
      name: 'a clean round cannot publish from a different live checkout',
      actual: authorizeReviewPublication(cleanInput, clean.headOid, {
        ...clean.checkout,
        repositoryFingerprint: 'f'.repeat(64),
      }).authorized,
      expected: false,
    },
    {
      name: 'a clean round cannot publish from a dirty live checkout',
      actual: authorizeReviewPublication(cleanInput, clean.headOid, {
        ...clean.checkout,
        clean: false,
      }).authorized,
      expected: false,
    },
    {
      name: 'invalid evidence fails publication without throwing',
      actual: authorizeReviewPublication(
        { ...cleanInput, round: null },
        clean.headOid,
        clean.checkout,
      ).authorized,
      expected: false,
    },
    {
      name: 'publication reports a stable review evidence fingerprint',
      actual: HASH_RE.test(
        authorizeReviewPublication(cleanInput, clean.headOid, clean.checkout)
          .reviewEvidenceFingerprint ?? '',
      ),
      expected: true,
    },
  ];
  for (const fixture of appendCases) {
    if (fixture.actual === fixture.expected) {
      passed += 1;
    } else {
      console.error(
        `FAIL ${fixture.name}: expected ${fixture.expected}, got ${fixture.actual}`,
      );
    }
  }

  for (const fixture of [...builderCases, ...publicationCases]) {
    if (fixture.actual === fixture.expected) {
      passed += 1;
    } else {
      console.error(
        `FAIL ${fixture.name}: expected ${fixture.expected}, got ${fixture.actual}`,
      );
    }
  }

  const total = cases.length + appendCases.length + builderCases.length
    + publicationCases.length;
  console.log(
    passed === total
      ? `self-test OK (${passed} cases)`
      : `self-test FAILED (${passed}/${total})`,
  );
  return passed === total;
}

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1] ?? null;
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// `dispatchId` identifies the reviewer process. The run convention is the
// result file's mtime in epoch-ms, which is distinct per dispatch by
// construction and needs nothing the caller must remember to vary.
function appendMain(args) {
  const evidenceFile = flagValue(args, '--evidence-file');
  const resultFile = flagValue(args, '--result-file');
  if (evidenceFile === null || resultFile === null) {
    process.stderr.write(
      'review-contract: --append-escalation-round requires --evidence-file '
      + '<path> --result-file <path> '
      + '[--annotations-file <path>] [--dispatch-id <id>] [--out <path>]\n',
    );
    process.exit(2);
  }
  let evidence;
  let result;
  let annotations;
  try {
    evidence = readJsonFile(evidenceFile);
    result = readJsonFile(resultFile);
    const annotationsFile = flagValue(args, '--annotations-file');
    annotations = annotationsFile === null ? [] : readJsonFile(annotationsFile);
  } catch (error) {
    process.stderr.write(`review-contract: unreadable input: ${error.message}\n`);
    process.exit(2);
  }
  const appended = appendEscalationRound(evidence, result, {
    dispatchId: flagValue(args, '--dispatch-id')
      ?? String(statSync(resultFile).mtimeMs).replace('.', '-'),
    findingAnnotations: annotations,
  });
  if (appended.ok !== true) {
    process.stdout.write(`${JSON.stringify(appended)}\n`);
    process.exit(1);
  }
  writeEvidence(args, appended);
}

function writeEvidence(args, appended) {
  const body = `${JSON.stringify(appended.evidence, null, 1)}\n`;
  const out = flagValue(args, '--out');
  if (out === null) {
    process.stdout.write(body);
    return;
  }
  writeFileSync(out, body);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    code: appended.code,
    round: appended.evidence.round,
    out,
  })}\n`);
}

// `--append-round` is one bare command by design: no redirect (`--out`), no
// pipe, no pre-built skeleton. A classifier judges a compound command whole,
// and a live run lost five tool calls to chains that wrapped this contract in
// `jq` and `&&`.
function appendRoundMain(args) {
  const usage = 'review-contract: --append-round --result-file <path> '
    + '(--first-round --plan-fingerprint <sha256> --author <engine:model> '
    + '--state <base>/.autoloop/config.json [--base-oid <oid>] [--boundary-file <plan-result.json>] '
    + '[--implement-result-file <implement-result.json>] | --evidence-file <path> '
    + '--scope full|delta [--dispositions-file <path>] '
    + '[--plan-fingerprint <sha256 of the re-plan>] [--rework-authorization-file <path>]) '
    + '[--annotations-file <path>] [--checkout <dir>] [--out <path>]\n';
  const resultFile = flagValue(args, '--result-file');
  const first = args.includes('--first-round');
  const evidenceFile = flagValue(args, '--evidence-file');
  if (resultFile === null || first === (evidenceFile !== null)) {
    process.stderr.write(usage);
    process.exit(2);
  }
  const optionalJson = (flag) => {
    const path = flagValue(args, flag);
    return path === null ? [] : readJsonFile(path);
  };
  const root = flagValue(args, '--checkout') ?? process.cwd();
  let options;
  let evidence = null;
  let result;
  try {
    result = readJsonFile(resultFile);
    const checkout = snapshotExecutionCheckout(root);
    options = {
      scope: first ? 'full' : flagValue(args, '--scope'),
      checkout,
      artifactFingerprint: artifactFingerprintOf(checkout.root),
      dispatchId: flagValue(args, '--dispatch-id')
        ?? String(statSync(resultFile).mtimeMs).replace('.', '-'),
      findingAnnotations: optionalJson('--annotations-file'),
      dispositions: optionalJson('--dispositions-file'),
      // A later round names a plan fingerprint only when it is the re-plan.
      ...(first || flagValue(args, '--plan-fingerprint') === null
        ? {}
        : { planFingerprint: flagValue(args, '--plan-fingerprint') }),
      // The rework a hand-off took (unit.mjs --rework-authorization writes it).
      ...(flagValue(args, '--rework-authorization-file') === null
        ? {}
        : { reworkAuthorization: readJsonFile(flagValue(args, '--rework-authorization-file')) }),
    };
    if (first) {
      const projectConfig = projectConfigForReview(flagValue(args, '--state') ?? '');
      const baseOid = flagValue(args, '--base-oid') ?? String(spawnSync(
        'git',
        ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${projectConfig.baseBranch}`],
        { cwd: checkout.root, encoding: 'utf8', timeout: 15000 },
      ).stdout ?? '').trim();
      options.first = {
        projectConfig,
        planFingerprint: flagValue(args, '--plan-fingerprint'),
        authorIdentity: flagValue(args, '--author'),
        configuredBaseOid: baseOid,
      };
      // The plan boundary, widened by the implementer's extra paths
      // (SPEC-elastic-scope); the refusal is the widening's own.
      const boundaryFile = flagValue(args, '--boundary-file');
      if (boundaryFile !== null) {
        const planResult = readJsonFile(boundaryFile);
        const boundary = Array.isArray(planResult) ? planResult : planResult?.plan?.boundary ?? planResult?.boundary;
        const implementFile = flagValue(args, '--implement-result-file');
        const widened = widenFromImplementer(
          implementFile === null ? { ok: true } : readJsonFile(implementFile), boundary,
        );
        if (widened.ok !== true) {
          process.stdout.write(`${JSON.stringify(widened)}\n`);
          process.exit(1);
        }
        options.first.boundary = widened.boundary;
        options.first.scopeChanges = widened.scopeChanges;
      }
    } else {
      evidence = readJsonFile(evidenceFile);
      // The fix delta's changed paths, for the widening coverage of a delta round.
      if (options.scope === 'delta') {
        const previousHead = evidence?.reviewRounds?.at(-1)?.headOid;
        options.deltaPaths = OID_RE.test(previousHead ?? '') ? deltaPathsOf(checkout.root, previousHead) ?? [] : [];
      }
    }
  } catch (error) {
    process.stderr.write(`review-contract: unreadable input: ${error.message}\n`);
    process.exit(2);
  }
  const appended = appendRound(evidence, result, options);
  if (appended.ok !== true) {
    process.stdout.write(`${JSON.stringify(appended)}\n`);
    process.exit(1);
  }
  writeEvidence(args, appended);
}

function main() {
  if (process.argv.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  if (process.argv.includes('--append-round')) {
    appendRoundMain(process.argv.slice(2));
    return;
  }
  if (process.argv.includes('--append-escalation-round')) {
    appendMain(process.argv.slice(2));
    return;
  }
  const raw = readFileSync(0, 'utf8');
  if (Buffer.byteLength(raw) > MAX_INPUT_BYTES) {
    process.stdout.write(
      `${JSON.stringify(decision('error', 'INVALID_REVIEW_INPUT'))}\n`,
    );
    process.exit(1);
  }
  try {
    process.stdout.write(
      `${JSON.stringify(reviewTransition(JSON.parse(raw)))}\n`,
    );
  } catch {
    process.stdout.write(
      `${JSON.stringify(decision('error', 'INVALID_REVIEW_INPUT'))}\n`,
    );
    process.exit(1);
  }
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url))
      === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMain) main();
