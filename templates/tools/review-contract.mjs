#!/usr/bin/env node

// Code-review convergence: the authority for clean / continue / block / cap.
//
// Every decision this file made under the broker survives unchanged — round 1
// covers the complete artifact, rounds 2+ cover only the fix delta plus open
// rebuts, a verified Critical/Major outside a later delta earns a full round,
// Majors still open past the closing round are handed off at merge, a Critical
// there reaches the cap, and a rebut closes only when a fresh reviewer accepts
// that exact finding ID.
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
//   node tools/agentic/review-contract.mjs < review-input.json
//   node tools/agentic/review-contract.mjs --self-test

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotExecutionCheckout } from './checkout-contract.mjs';
import { extractConfig, validateProjectConfig } from './config-contract.mjs';
import { validReviewVerdict } from './dispatch.mjs';

const GATING_SEVERITIES = new Set(['Critical', 'Major']);
const REVIEW_SCOPES = new Map([
  ['full', 'full-artifact'],
  ['delta', 'fix-delta-and-open-rebuttals'],
]);
const HASH_RE = /^[0-9a-f]{64}$/;
const OID_RE = /^[0-9a-f]{40}$/;
const FINDING_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IDENTITY_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const DISPATCH_ID_RE = IDENTITY_RE;
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const DISPOSITIONS = new Set(['fix', 'rebut', 'defer']);
// A Major the fixes keep missing is not worth another round of the same fix:
// after this many raisings it may be deferred to a filed follow-up issue, which
// the PR body lists, so the human still sees it at merge. A Critical never is.
const DEFER_AFTER_RAISINGS = 3;
const FOLLOW_UP_RE = /#[1-9][0-9]*/u;
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
      hasExactKeys(annotation, ['id', 'verified', 'inScope'])
      && FINDING_ID_RE.test(annotation.id)
      && typeof annotation.verified === 'boolean'
      && typeof annotation.inScope === 'boolean');
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
  return hasExactKeys(entry, LEDGER_KEYS)
    && FINDING_ID_RE.test(entry.findingId)
    && GATING_SEVERITIES.has(entry.severity)
    && boundedText(entry.summary, 1, 4096)
    && boundedText(entry.evidence, 0, 16384)
    && DISPOSITIONS.has(entry.disposition)
    && LEDGER_STATES.has(entry.state)
    && boundedText(entry.rationale, 1, 4096)
    && (entry.disposition !== 'defer'
      || (entry.severity === 'Major' && FOLLOW_UP_RE.test(entry.rationale)));
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
export function validReviewRound(record) {
  return hasExactKeys(record, ROUND_KEYS)
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
    && record.authorIdentity !== record.reviewerIdentity
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

// Convergence closes on a full-artifact round, and the closing round may be a
// re-read of bytes a delta round already saw. That round is distinguished by
// its SCOPE, not by its content: it reviews strictly more of the same artifact.
// Without this the rule deadlocks — the moment a delta round comes back clean,
// the mandated full round has nothing new to fingerprint and the chain refuses
// it as "nothing was re-reviewed". A live run hit exactly that, ran the closing
// round anyway, and could not record it.
function scopeEscalates(previous, current) {
  return isPlainObject(previous)
    && isPlainObject(current)
    && previous.scope === REVIEW_SCOPES.get('delta')
    && current.scope === REVIEW_SCOPES.get('full')
    && current.artifactFingerprint === previous.artifactFingerprint
    && current.artifactVersion === previous.artifactVersion
    && current.headOid === previous.headOid;
}

// A prior ledger entry leaves the gating set once it is closed, fixed,
// deferred, or rebutted with the rebuttal accepted.
function ledgerEntryCloses(entry, rebutsById) {
  return entry.state === 'closed'
    || entry.disposition === 'fix'
    || entry.disposition === 'defer'
    || rebutsById.get(entry.findingId)?.status === 'accepted';
}

// The one round past the cap that is not an escalation: the cap round still
// gated, the fix went in, and nothing had reviewed it. Handing off there left an
// unreviewed commit on the PR; one full round over it closes or hands off with
// evidence. Full only, and only after a cap round that actually gated.
function closesCappedFindings(input) {
  const rounds = input.reviewRounds;
  const capVerdict = Array.isArray(rounds) && rounds.length >= 2
    ? rounds.at(-2)?.verdict
    : undefined;
  return input.scope === 'full'
    && isPlainObject(capVerdict)
    && Array.isArray(capVerdict.findings)
    && Array.isArray(capVerdict.rebuts)
    && (gatingFindings(capVerdict).length > 0
      || capVerdict.rebuts.some(({ status }) => status === 'rejected'));
}

function closesByScopeEscalation(rounds) {
  return Array.isArray(rounds)
    && rounds.length >= 2
    && scopeEscalates(rounds.at(-2), rounds.at(-1));
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
  const stable = [
    'planFingerprint',
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
    if (scopeEscalates(previous, current)) continue;
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
        + 're-reviewed. A closing full-artifact round over an unchanged '
        + 'artifact must also carry the previous round\'s artifactVersion and '
        + 'headOid to record as a scope escalation',
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

export function reviewTransition(input) {
  if (
    !hasExactKeys(input, [
      'round',
      'scope',
      'projectConfig',
      'expected',
      'findingAnnotations',
      'reviewRounds',
    ])
    || !Number.isSafeInteger(input.round)
    || input.round < 1
    || !REVIEW_SCOPES.has(input.scope)
    // Round 1 is always the complete artifact. Later rounds are delta while
    // fixes churn — and FULL when closing: 0.46.0 made "convergence closes on
    // a full-artifact round" the rule, and this line kept refusing it, so the
    // optimistic close was prose a live session could not execute.
    || (input.round === 1 && input.scope !== 'full')
    || validateProjectConfig(input.projectConfig).length > 0
    || (input.round > input.projectConfig.caps.codeReviewRoundsPerUnit
      && !(input.round === input.projectConfig.caps.codeReviewRoundsPerUnit + 1
        && (closesByScopeEscalation(input.reviewRounds)
          || closesCappedFindings(input))))
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
  for (const entry of deferred) {
    const raisings = history.rounds.slice(0, -1).filter(({ verdict }) =>
      verdict.findings.some(({ id }) => id === entry.findingId)).length;
    if (raisings < DEFER_AFTER_RAISINGS) {
      return decision('error', 'INVALID_REVIEW_EVIDENCE', {
        evidenceGap: `finding ${entry.findingId} is deferred after ${raisings} raising(s); `
          + `only a Major raised in ${DEFER_AFTER_RAISINGS} rounds may be deferred — fix or rebut it`,
      });
    }
  }
  const deferredIds = new Set(deferred.map(({ findingId }) => findingId));
  // The evidence every publishable (clean) decision carries.
  const closedEvidence = () => ({
    ...(deferred.length === 0 ? {} : {
      deferredFindings: deferred.map(({ findingId, rationale }) => ({ findingId, rationale })),
    }),
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

  const late = input.scope === 'delta'
    ? currentGating.filter(({ id }) => annotations.get(id).inScope !== true)
    : [];
  // A real defect the delta could not see is a reason to look wider, not to
  // stop: fix it and review the whole artifact. At the cap that full round is
  // the closing round.
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
  if (input.round === input.projectConfig.caps.codeReviewRoundsPerUnit) {
    return decision('continue', 'REVIEW_CLOSING_ROUND_REQUIRED', {
      unresolvedFindings: currentGating.length,
      rejectedRebuts: rejectedRebuts.length,
    });
  }
  // Past the closing round a Major is handed to the human at merge instead of
  // parking the unit: the loop files each as a follow-up and lists it in the PR
  // body. Only under manual policy, so a hand-off can never reach auto-merge,
  // and never with a Critical open.
  if (
    input.round > input.projectConfig.caps.codeReviewRoundsPerUnit
    && input.projectConfig.merge?.policy === 'manual'
    && currentGating.every(({ severity }) => severity === 'Major')
  ) {
    return decision('clean', 'REVIEW_CAP_HANDOFF', {
      handedOffFindings: currentGating.map(({ id, severity }) => ({ id, severity })),
      ...closedEvidence(),
    });
  }
  if (input.round > input.projectConfig.caps.codeReviewRoundsPerUnit) {
    // The cap is spent, and the unit cannot ship as it stands. What happens next
    // is the loop's decision (re-plan), not a human's by default.
    return decision('cap-reached', 'REVIEW_CAP_REACHED', {
      unresolvedFindings: currentGating.length,
      rejectedRebuts: rejectedRebuts.length,
    });
  }
  return decision('continue', 'REVIEW_FIX_DELTA_REQUIRED', {
    unresolvedFindings: currentGating.length,
    rejectedRebuts: rejectedRebuts.length,
  });
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
  const appended = {
    ...evidence,
    round: evidence.round + 1,
    scope: 'full',
    findingAnnotations: annotations,
    reviewRounds: [
      ...evidence.reviewRounds,
      {
        ...structuredClone(previous),
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
function dispositionLedgerEntry(finding, disposition) {
  return {
    findingId: finding.id,
    severity: finding.severity,
    summary: finding.summary,
    evidence: finding.evidence,
    disposition: disposition.disposition,
    state: 'open',
    rationale: disposition.rationale,
  };
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
  if (evidence === null || evidence === undefined) {
    const first = options.first;
    if (
      !isPlainObject(first)
      || validateProjectConfig(first.projectConfig).length > 0
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
    };
  } else {
    const previous = evidence?.reviewRounds?.at(-1);
    if (!validReviewRound(previous)) {
      return refuse('INVALID_EVIDENCE', 'the evidence carries no valid previous round');
    }
    if (!REVIEW_SCOPES.has(options.scope)) {
      return refuse('INVALID_SCOPE', 'scope must be full or delta');
    }
    const dispositions = new Map(
      (options.dispositions ?? []).map((entry) => [entry?.findingId, entry]),
    );
    // A deferral stands until the unit closes: a reviewer re-raising an already
    // filed finding gets the same deferral, not a new judgement to make.
    for (const entry of previous.priorFindings) {
      if (entry.disposition === 'defer' && !dispositions.has(entry.findingId)) {
        dispositions.set(entry.findingId, {
          findingId: entry.findingId, disposition: 'defer', rationale: entry.rationale,
        });
      }
    }
    const previousGating = gatingFindings(previous.verdict);
    for (const finding of previousGating) {
      const disposition = dispositions.get(finding.id);
      if (!DISPOSITIONS.has(disposition?.disposition)
        || !boundedText(disposition.rationale, 1, 4096)) {
        return refuse(
          'DISPOSITION_REQUIRED',
          `finding ${finding.id} gated the previous round; dispose it as fix, `
          + 'rebut, or (a Major raised in 3 rounds) defer naming its follow-up #N, '
          + 'with a rationale',
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
      priorFindings.push(dispositionLedgerEntry(finding, disposition));
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
      planFingerprint: previous.planFingerprint,
      configFingerprint: previous.configFingerprint,
      configuredBaseOid: previous.configuredBaseOid,
      deltaBaseOid: previous.headOid,
      authorIdentity: previous.authorIdentity,
      artifactVersion: previous.artifactVersion + 1,
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
  };
  const appended = {
    round: base.round,
    scope: base.scope,
    projectConfig: structuredClone(base.projectConfig),
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
  return validatedAppend(appended);
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
  };
}

function fixtureProjectConfig(codeReviewRoundsPerUnit = 5) {
  return {
    version: '0.27.0',
    baseBranch: 'main',
    gate: { command: 'npm test', quickCommand: null, setupCommand: null },
    merge: { policy: 'manual' },
    tracker: { provider: 'none' },
    review: { checklistPath: 'docs/agentic/checklist.md' },
    caps: {
      gateRetriesPerUnit: 2,
      codeReviewRoundsPerUnit,
      sliceMaxLines: 700,
      sliceMaxFiles: 10,
    },
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
        ledger.set(prior.id, {
          findingId: prior.id,
          severity: prior.severity,
          summary: prior.summary,
          evidence: prior.evidence,
          disposition: rebutted ? 'rebut' : deferred ? 'defer' : 'fix',
          state: 'open',
          rationale: rebutted
            ? 'The author supplied a bounded rebuttal with evidence.'
            : deferred
              ? overrides.deferRationale ?? 'Deferred to follow-up #99.'
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
      planFingerprint: overrides.planFingerprint ?? planFingerprint,
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

  const escalationCap = fixtureProjectConfig(2);
  const escalationFactory = roundFactory(escalationCap, { seed: 'escalation' });
  const escalationFirst = escalationFactory(1, failWith([finding]));
  const escalationDelta = escalationFactory(2, pass);
  const widerFactory = roundFactory(escalationCap, { seed: 'wider' });
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

  const lateFactory = roundFactory(fixtureProjectConfig(), { seed: 'late' });
  const lateClean = lateFactory(1, pass);
  const late = lateFactory(2, failWith([lateFinding]));

  const configuredCap = fixtureProjectConfig(1);
  const cappedFailure = roundFactory(configuredCap, { seed: 'capped' })(
    1,
    failWith([finding]),
  );

  // self-resolving-units: the cap round earns one closing full round.
  const closingFactory = roundFactory(configuredCap, { seed: 'closing' });
  const closingFirst = closingFactory(1, failWith([finding]));
  const closingStillFails = closingFactory(2, failWith([cumulativeFinding]), {
    scope: 'full-artifact',
  });
  const closingCleanFactory = roundFactory(configuredCap, { seed: 'closing-clean' });
  const closingCleanFirst = closingCleanFactory(1, failWith([finding]));
  const closingClean = closingCleanFactory(2, pass, { scope: 'full-artifact' });
  // limits-never-stop: a closing round that still gates on Majors alone hands
  // the unit off at merge under manual policy; a Critical or a non-manual
  // policy still blocks.
  const closingCriticalFactory = roundFactory(configuredCap, { seed: 'closing-critical' });
  const closingCriticalFirst = closingCriticalFactory(1, failWith([finding]));
  const closingCritical = closingCriticalFactory(
    2,
    failWith([{ ...cumulativeFinding, id: 'finding-critical', severity: 'Critical' }]),
    { scope: 'full-artifact' },
  );
  const ratifiedCap = { ...fixtureProjectConfig(1), merge: { policy: 'ratified' } };
  const closingRatifiedFactory = roundFactory(ratifiedCap, { seed: 'closing-ratified' });
  const closingRatifiedFirst = closingRatifiedFactory(1, failWith([finding]));
  const closingRatified = closingRatifiedFactory(2, failWith([cumulativeFinding]), {
    scope: 'full-artifact',
  });
  const closingDeltaFactory = roundFactory(configuredCap, { seed: 'closing-delta' });
  const closingDeltaFirst = closingDeltaFactory(1, failWith([finding]));
  const closingDelta = closingDeltaFactory(2, pass);
  const beyondFactory = roundFactory(configuredCap, { seed: 'beyond' });
  const beyondRounds = [
    beyondFactory(1, failWith([finding])),
    beyondFactory(2, failWith([cumulativeFinding]), { scope: 'full-artifact' }),
  ];
  beyondRounds.push(beyondFactory(3, pass, { scope: 'full-artifact' }));

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
      name: 'a full round past the cap that is not a scope escalation is refused',
      input: inputFor(
        [widerFirst, widerDelta, escalationWiderArtifact],
        escalationCap,
        { scope: 'full' },
      ),
      expected: ['error', false],
      expectedCode: 'INVALID_REVIEW_INPUT',
    },
    {
      name: 'a full-artifact round re-reading the delta head closes the review',
      input: inputFor(
        [escalationFirst, escalationDelta, escalationClose],
        escalationCap,
        { scope: 'full' },
      ),
      expected: ['clean', true],
    },
    {
      name: 'a Major continues below the cap',
      input: inputFor([acceptedFirst]),
      expected: ['continue', false],
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
      name: 'a gating finding at the cap earns one closing full round',
      input: inputFor([cappedFailure], configuredCap),
      expected: ['continue', false],
      expectedCode: 'REVIEW_CLOSING_ROUND_REQUIRED',
    },
    {
      name: 'a closing round that still gates on Majors hands the unit off at merge',
      input: inputFor([closingFirst, closingStillFails], configuredCap, { scope: 'full' }),
      expected: ['clean', true],
      expectedCode: 'REVIEW_CAP_HANDOFF',
    },
    {
      name: 'a closing round that still gates on a Critical reaches the cap',
      input: inputFor([closingCriticalFirst, closingCritical], configuredCap, { scope: 'full' }),
      expected: ['cap-reached', false],
      expectedCode: 'REVIEW_CAP_REACHED',
    },
    {
      name: 'a closing round under a non-manual merge policy reaches the cap',
      input: inputFor([closingRatifiedFirst, closingRatified], ratifiedCap, { scope: 'full' }),
      expected: ['cap-reached', false],
      expectedCode: 'REVIEW_CAP_REACHED',
    },
    {
      name: 'a clean closing round past the cap publishes',
      input: inputFor([closingCleanFirst, closingClean], configuredCap, { scope: 'full' }),
      expected: ['clean', true],
    },
    {
      name: 'the closing round past the cap is always full',
      input: inputFor([closingDeltaFirst, closingDelta], configuredCap),
      expected: ['error', false],
      expectedCode: 'INVALID_REVIEW_INPUT',
    },
    {
      name: 'there is no round after the closing round',
      input: inputFor(beyondRounds, configuredCap, { scope: 'full' }),
      expected: ['error', false],
      expectedCode: 'INVALID_REVIEW_INPUT',
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
    {
      name: 'the caller cannot inflate the configured review cap',
      input: {
        ...inputFor([acceptedFirst]),
        projectConfig: {
          ...fixtureProjectConfig(),
          caps: { ...fixtureProjectConfig().caps, codeReviewRoundsPerUnit: 20 },
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
          writeFileSync(join(root, 'a.txt'), 'two\n');
          git('commit', '--quiet', '-am', 'two');
          const changed = artifactFingerprintOf(root);
          return HASH_RE.test(first) && first === same && changed !== first;
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      })(),
      expected: true,
    },
  ];

  const cleanInput = inputFor([clean]);
  const handoffInput = inputFor([closingFirst, closingStillFails], configuredCap, { scope: 'full' });
  const publicationCases = [
    {
      name: 'a cap hand-off publishes its reviewed head and names the handed-off Majors',
      actual: (() => {
        const authorization = authorizeReviewPublication(
          handoffInput,
          closingStillFails.headOid,
          closingStillFails.checkout,
        );
        return authorization.authorized
          && authorization.code === 'REVIEW_CAP_HANDOFF'
          && JSON.stringify(reviewTransition(handoffInput).handedOffFindings)
            === JSON.stringify([{ id: cumulativeFinding.id, severity: 'Major' }]);
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
    + '--state <base STATE.md> [--base-oid <oid>] | --evidence-file <path> '
    + '--scope full|delta [--dispositions-file <path>]) '
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
    };
    if (first) {
      const projectConfig = extractConfig(readFileSync(flagValue(args, '--state') ?? '', 'utf8'));
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
    } else {
      evidence = readJsonFile(evidenceFile);
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
