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

function findingCoreMatches(ledgerFinding, finding) {
  return ledgerFinding.findingId === finding.id
    && ledgerFinding.severity === finding.severity
    && ledgerFinding.summary === finding.summary
    && ledgerFinding.evidence === finding.evidence;
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

function roundHistory(rounds, round, scope, expected, projectConfig) {
  if (
    !Array.isArray(rounds)
    || rounds.length !== round
    || rounds.some((record) => !validReviewRound(record))
  ) {
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
  if (
    rounds.some((record, index) =>
      record.round !== index + 1
      || record.scope !== (
        index === 0
          ? REVIEW_SCOPES.get('full')
          : REVIEW_SCOPES.get('delta')
      )
      || stable.some((key) => record[key] !== first[key]))
    || rounds.some((record) =>
      record.checkout.root !== first.checkout.root
      || record.checkout.branch !== first.checkout.branch)
    // A repeated dispatch id is a replayed reviewer, not a fresh one.
    || new Set(rounds.map(({ dispatchId }) => dispatchId)).size !== rounds.length
    || rounds.some((record) => !verdictMatchesOpenRebuts(record))
  ) {
    return null;
  }
  if (first.configFingerprint !== hashValue(projectConfig)) return null;
  if (rounds[0].deltaBaseOid !== first.configuredBaseOid) return null;
  for (let index = 1; index < rounds.length; index += 1) {
    const previous = rounds[index - 1];
    const current = rounds[index];
    if (
      current.deltaBaseOid !== previous.headOid
      || !validCumulativeLedger(previous, current)
      || current.artifactVersion <= previous.artifactVersion
      || current.artifactFingerprint === previous.artifactFingerprint
    ) {
      return null;
    }
  }
  const current = rounds.at(-1);
  if (
    current.scope !== REVIEW_SCOPES.get(scope)
    || current.planFingerprint !== expected.planFingerprint
    || current.repositoryFingerprint !== expected.repositoryFingerprint
    || current.configuredBaseOid !== expected.configuredBaseOid
    || current.artifactVersion !== expected.artifactVersion
    || current.artifactFingerprint !== expected.artifactFingerprint
    || current.headOid !== expected.headOid
  ) {
    return null;
  }
  return { current, rounds };
}

function authenticatedFindings(rounds) {
  const history = new Map();
  for (const record of rounds) {
    for (const finding of record.verdict.findings) {
      const previous = history.get(finding.id);
      if (
        previous
        && (
          previous.severity !== finding.severity
          || previous.summary !== finding.summary
          || previous.evidence !== finding.evidence
        )
      ) {
        return null;
      }
      history.set(finding.id, finding);
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
    || (input.round === 1 && input.scope !== 'full')
    || (input.round > 1 && input.scope !== 'delta')
    || validateProjectConfig(input.projectConfig).length > 0
    || input.round > input.projectConfig.caps.codeReviewRoundsPerUnit
    || !validExpected(input.expected)
    || !validAnnotations(input.findingAnnotations)
  ) {
    return decision('error', 'INVALID_REVIEW_INPUT');
  }

  const history = roundHistory(
    input.reviewRounds,
    input.round,
    input.scope,
    input.expected,
    input.projectConfig,
  );
  if (!history) return decision('error', 'INVALID_REVIEW_EVIDENCE');
  if (!authenticatedFindings(history.rounds)) {
    return decision('error', 'INVALID_REVIEW_EVIDENCE');
  }

  const currentVerdict = history.current.verdict;
  const currentIds = currentVerdict.findings.map(({ id }) => id);
  const annotationIds = input.findingAnnotations.map(({ id }) => id);
  const rebutIds = history.current.openRebuttals.map(({ findingId }) => findingId);
  const authenticatedRebutIds = currentVerdict.rebuts.map(
    ({ findingId }) => findingId,
  );
  if (
    !sameSet(currentIds, annotationIds)
    || !sameSet(rebutIds, authenticatedRebutIds)
    || (input.round === 1 && rebutIds.length > 0)
  ) {
    return decision('error', 'INVALID_REVIEW_EVIDENCE');
  }

  const annotations = new Map(
    input.findingAnnotations.map((annotation) => [annotation.id, annotation]),
  );
  const currentGating = gatingFindings(currentVerdict);
  const currentGatingIds = new Set(currentGating.map(({ id }) => id));
  if (
    currentVerdict.rebuts.some(({ findingId, status }) =>
      status === 'accepted'
        ? currentGatingIds.has(findingId)
        : !currentGatingIds.has(findingId))
  ) {
    return decision('error', 'INVALID_REVIEW_EVIDENCE');
  }
  if (
    input.round === 1
    && input.findingAnnotations.some(({ inScope }) => inScope !== true)
  ) {
    return decision('error', 'INVALID_REVIEW_EVIDENCE');
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
      scope: round === 1 ? REVIEW_SCOPES.get('full') : REVIEW_SCOPES.get('delta'),
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
  });

  const fixedFactory = roundFactory(fixtureProjectConfig(), { seed: 'fixed' });
  const fixedFirst = fixedFactory(1, failWith([finding]));
  const fixed = fixedFactory(2, pass);

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
  const cumulativeThird = cumulativeFactory(3, pass);

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
      name: 'a Major continues below the cap',
      input: inputFor([acceptedFirst]),
      expected: ['continue', false],
    },
    {
      name: 'an accepted rebut permits a clean result',
      input: inputFor([acceptedFirst, accepted]),
      expected: ['clean', true],
    },
    {
      name: 'a reviewed fix permits a clean result',
      input: inputFor([fixedFirst, fixed]),
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
      input: inputFor([cumulativeFirst, cumulativeSecond, cumulativeThird]),
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
