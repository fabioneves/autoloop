#!/usr/bin/env node

// Code-review convergence: the authority for clean / continue / block / cap.
//
// Every decision this file made under the broker survives unchanged — round 1
// covers the complete artifact, rounds 2+ cover only the fix delta plus open
// rebuts, a verified Critical/Major outside a later delta enters the human-block
// path, an unresolved Major at the cap blocks, and a rebut closes only when a
// fresh reviewer accepts that exact finding ID.
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
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateProjectConfig } from './config-contract.mjs';
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
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const DISPOSITIONS = new Set(['fix', 'rebut']);
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
    && boundedText(entry.rationale, 1, 4096);
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
    const expectedState = previousFinding.state === 'closed'
      ? 'closed'
      : previousFinding.disposition === 'fix'
        ? 'closed'
        : previousRebuts.get(id)?.status === 'accepted'
          ? 'closed'
          : null;
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
    gaps.push("round 1: deltaBaseOid must equal the configured base");
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
        && closesByScopeEscalation(input.reviewRounds)))
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

  const annotations = new Map(
    input.findingAnnotations.map((annotation) => [annotation.id, annotation]),
  );
  const currentGating = gatingFindings(currentVerdict);
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
  if (late.length > 0) {
    return decision('human-block', 'VERIFIED_OUT_OF_DELTA_FINDING', {
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
    return decision('clean', 'REVIEW_CLEAN', {
      reviewedHead: history.current.headOid,
      reviewedCheckout: structuredClone(history.current.checkout),
      reviewEvidenceFingerprint: hashValue(history.current),
    });
  }
  if (input.round >= input.projectConfig.caps.codeReviewRoundsPerUnit) {
    return decision('human-block', 'REVIEW_CAP_REACHED', {
      unresolvedFindings: currentGating.length,
      rejectedRebuts: rejectedRebuts.length,
    });
  }
  return decision('continue', 'REVIEW_FIX_DELTA_REQUIRED', {
    unresolvedFindings: currentGating.length,
    rejectedRebuts: rejectedRebuts.length,
  });
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
    version: '0.26.0',
    baseBranch: 'main',
    gate: { command: 'npm test', quickCommand: null, setupCommand: null },
    merge: { policy: 'manual' },
    tracker: { provider: 'none' },
    review: { checklistPath: 'docs/agentic/checklist.md' },
    caps: {
      gateRetriesPerUnit: 2,
      reviseRoundsPerPr: 3,
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
        finding.state = finding.disposition === 'fix'
          ? 'closed'
          : previousRebuts.get(finding.findingId)?.status === 'accepted'
            ? 'closed'
            : finding.state;
      }
      for (const prior of previousGating.values()) {
        const rebutted = verdict.rebuts.some(
          ({ findingId }) => findingId === prior.id,
        );
        ledger.set(prior.id, {
          findingId: prior.id,
          severity: prior.severity,
          summary: prior.summary,
          evidence: prior.evidence,
          disposition: rebutted ? 'rebut' : 'fix',
          state: 'open',
          rationale: rebutted
            ? 'The author supplied a bounded rebuttal with evidence.'
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
      name: 'verified out-of-delta Major blocks for a human',
      input: {
        ...inputFor([lateClean, late]),
        findingAnnotations: [{ id: lateFinding.id, verified: true, inScope: false }],
      },
      expected: ['human-block', false],
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
      name: 'a gating finding at the cap blocks',
      input: inputFor([cappedFailure], configuredCap),
      expected: ['human-block', false],
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

  const cleanInput = inputFor([clean]);
  const publicationCases = [
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
  for (const fixture of publicationCases) {
    if (fixture.actual === fixture.expected) {
      passed += 1;
    } else {
      console.error(
        `FAIL ${fixture.name}: expected ${fixture.expected}, got ${fixture.actual}`,
      );
    }
  }

  const total = cases.length + publicationCases.length;
  console.log(
    passed === total
      ? `self-test OK (${passed} cases)`
      : `self-test FAILED (${passed}/${total})`,
  );
  return passed === total;
}

function main() {
  if (process.argv.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
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
