#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyLaneProof } from './lane-contract.mjs';
import { validateProjectConfig } from './config-contract.mjs';
import {
  CAPABILITY_REQUIREMENTS,
  INTENT_PROVENANCE,
  initializeRouteState,
  observe,
  open,
  plan,
  refreshRouteState,
  validateRuntimeReceipt,
} from './runtime-contract.mjs';
import {
  artifactSourceFingerprint,
  classifyRouteAttempt,
  compileRouteAttempt,
  issueCapabilitySnapshot,
  issueHostAttemptReceipt,
  issueHostEvidence,
  snapshotExecutionCheckout,
} from './route-adapter-contract.mjs';

const GATING_SEVERITIES = new Set(['Critical', 'Major']);
const REVIEW_SCOPES = new Map([
  ['full', 'full-artifact'],
  ['delta', 'fix-delta-and-open-rebuttals'],
]);
const HASH_RE = /^[0-9a-f]{64}$/;
const OID_RE = /^[0-9a-f]{40}$/;
const FINDING_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_INPUT_BYTES = 32 * 1024 * 1024;

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

function hashValue(value) {
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

function validExpected(expected) {
  return hasExactKeys(expected, [
    'runInstanceFingerprint',
    'planFingerprint',
    'repositoryFingerprint',
    'configuredBaseOid',
    'artifactVersion',
    'artifactFingerprint',
    'headOid',
  ])
    && HASH_RE.test(expected.runInstanceFingerprint)
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

function verdictMatchesOpenRebuts(receipt) {
  const verdict = receipt.reviewVerdicts[0].verdict;
  const openIds = receipt.artifactSource.openRebuttals.map(
    ({ findingId }) => findingId,
  );
  const rebutIds = verdict.rebuts.map(({ findingId }) => findingId);
  const gatingIds = new Set(gatingFindings(verdict).map(({ id }) => id));
  return sameSet(openIds, rebutIds)
    && verdict.rebuts.every(({ findingId, status }) =>
      status === 'accepted'
        ? !gatingIds.has(findingId)
        : gatingIds.has(findingId));
}

function validCumulativeLedger(previous, current) {
  const previousVerdict = previous.reviewVerdicts[0].verdict;
  const previousGating = new Map(
    gatingFindings(previousVerdict).map((finding) => [finding.id, finding]),
  );
  const previousRebuts = new Map(
    previousVerdict.rebuts.map((rebut) => [rebut.findingId, rebut]),
  );
  const priorLedger = new Map(
    previous.artifactSource.priorFindings.map(
      (finding) => [finding.findingId, finding],
    ),
  );
  const currentLedger = new Map(
    current.artifactSource.priorFindings.map(
      (finding) => [finding.findingId, finding],
    ),
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
      if (
        previousFinding
        && !findingCoreMatches(previousFinding, repeated)
      ) {
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

function receiptHistory(
  receipts,
  round,
  scope,
  expected,
  projectConfig,
) {
  if (
    !Array.isArray(receipts)
    || receipts.length !== round
    || receipts.some((receipt) => !validateRuntimeReceipt(receipt))
  ) {
    return null;
  }
  const first = receipts[0];
  const stable = [
    'runIntentHash',
    'generation',
    'hostEvidenceFingerprint',
    'runInstanceFingerprint',
    'invocationNonce',
    'configFingerprint',
    'sessionFingerprint',
    'invocationFlow',
    'activeHost',
    'selector',
    'requestedEngine',
    'requestedRoute',
    'flow',
    'configuredBaseOid',
  ];
  const attempts = receipts.flatMap((receipt) => receipt.attempts);
  if (
    !['dev', 'pitcrew'].includes(first.flow)
    || receipts.some((receipt, index) =>
      receipt.stage !== 'code-review'
      || receipt.role !== 'reviewer'
      || receipt.round !== index + 1
      || receipt.reviewScope !== (
        index === 0
          ? REVIEW_SCOPES.get('full')
          : REVIEW_SCOPES.get('delta')
      )
      || stable.some((key) => receipt[key] !== first[key]))
    || receipts.some((receipt) =>
      receipt.checkout.root !== first.checkout.root
      || receipt.checkout.repositoryFingerprint
        !== first.checkout.repositoryFingerprint
      || receipt.checkout.branch !== first.checkout.branch)
    || new Set(receipts.map(({ fingerprint }) => fingerprint)).size
      !== receipts.length
    || new Set(receipts.map(({ planFingerprint }) => planFingerprint)).size
      !== receipts.length
    || new Set(attempts.map(({ executionEvidence }) =>
      executionEvidence.instanceId)).size !== attempts.length
    || new Set(attempts.map(({ evidenceFingerprint }) =>
      evidenceFingerprint)).size !== attempts.length
    || receipts.some((receipt) => !verdictMatchesOpenRebuts(receipt))
  ) {
    return null;
  }
  if (
    first.configFingerprint !== hashValue(projectConfig)
    || receipts.some(({ configFingerprint }) =>
      configFingerprint !== first.configFingerprint)
  ) {
    return null;
  }
  for (let index = 1; index < receipts.length; index += 1) {
    const previous = receipts[index - 1];
    const current = receipts[index];
    if (
      current.artifactSource.kind !== 'git-review'
      || current.artifactSource.deltaBaseOid
        !== previous.artifactSubject.headOid
      || !validCumulativeLedger(previous, current)
    ) {
      return null;
    }
    if (
      current.artifactVersion <= previous.artifactVersion
      || current.artifactFingerprint === previous.artifactFingerprint
    ) {
      return null;
    }
  }
  const current = receipts.at(-1);
  if (
    current.reviewScope !== REVIEW_SCOPES.get(scope)
    || current.runInstanceFingerprint !== expected.runInstanceFingerprint
    || current.planFingerprint !== expected.planFingerprint
    || current.checkout.repositoryFingerprint
      !== expected.repositoryFingerprint
    || current.configuredBaseOid !== expected.configuredBaseOid
    || current.artifactVersion !== expected.artifactVersion
    || current.artifactFingerprint !== expected.artifactFingerprint
    || current.artifactSubject.kind !== 'head'
    || current.artifactSubject.headOid !== expected.headOid
  ) {
    return null;
  }
  return { current, receipts };
}

function authenticatedFindings(receipts) {
  const history = new Map();
  for (const receipt of receipts) {
    const verdict = receipt.reviewVerdicts[0].verdict;
    for (const finding of verdict.findings) {
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
      'runtimeReceipts',
    ])
    || !Number.isSafeInteger(input.round)
    || input.round < 1
    || !REVIEW_SCOPES.has(input.scope)
    || (input.round === 1 && input.scope !== 'full')
    || (input.round > 1 && input.scope !== 'delta')
    || validateProjectConfig(input.projectConfig).length > 0
    || input.round
      > input.projectConfig.caps.codeReviewRoundsPerUnit
    || !validExpected(input.expected)
    || !validAnnotations(input.findingAnnotations)
  ) {
    return decision('error', 'INVALID_REVIEW_INPUT');
  }

  const history = receiptHistory(
    input.runtimeReceipts,
    input.round,
    input.scope,
    input.expected,
    input.projectConfig,
  );
  if (!history) {
    return decision('error', 'INVALID_REVIEW_EVIDENCE');
  }
  const findingsById = authenticatedFindings(history.receipts);
  if (!findingsById) {
    return decision('error', 'INVALID_REVIEW_EVIDENCE');
  }
  const currentVerdict = history.current.reviewVerdicts[0].verdict;
  const currentIds = currentVerdict.findings.map(({ id }) => id);
  const annotationIds = input.findingAnnotations.map(({ id }) => id);
  const rebutIds = history.current.artifactSource.openRebuttals.map(
    ({ findingId }) => findingId,
  );
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
  const currentGating = currentVerdict.findings.filter(({ severity }) =>
    GATING_SEVERITIES.has(severity));
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
  if (
    currentGating.some(({ id }) => annotations.get(id).verified !== true)
  ) {
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
      reviewedHead: history.current.artifactSubject.headOid,
      reviewedCheckout: structuredClone(history.current.checkout),
      runtimeReceiptFingerprint: history.current.fingerprint,
    });
  }
  if (
    input.round
      >= input.projectConfig.caps.codeReviewRoundsPerUnit
  ) {
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
    && hasExactKeys(liveCheckout, [
      'root',
      'repositoryFingerprint',
      'branch',
      'headOid',
      'clean',
    ])
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
    runtimeReceiptFingerprint:
      transition.runtimeReceiptFingerprint ?? null,
  };
}

function fixtureHash(value) {
  return hashValue(value);
}

function fixtureProjectConfig(codeReviewRoundsPerUnit = 5) {
  return {
    version: '0.25.0',
    baseBranch: 'main',
    gate: {
      command: 'npm test',
      quickCommand: null,
      setupCommand: null,
    },
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

const FIXTURE_REPOSITORIES = new Set();

function fixtureGit(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10000,
  }).trim();
}

function createFixtureRepository() {
  const root = mkdtempSync(join(tmpdir(), 'autoloop-review-contract-'));
  FIXTURE_REPOSITORIES.add(root);
  fixtureGit(root, ['init', '-b', 'main']);
  fixtureGit(root, ['config', 'user.name', 'Autoloop Review Contract']);
  fixtureGit(root, ['config', 'user.email', 'review-contract@example.invalid']);
  fixtureGit(root, [
    'remote',
    'add',
    'origin',
    `https://github.com/autoloop-fixtures/review-${randomUUID()}.git`,
  ]);
  writeFileSync(join(root, 'reviewed.txt'), 'base\n', 'utf8');
  fixtureGit(root, ['add', '--', 'reviewed.txt']);
  fixtureGit(root, ['commit', '-m', 'test: establish review base']);
  const baseOid = fixtureGit(root, ['rev-parse', 'HEAD']);
  fixtureGit(root, ['switch', '-c', 'feature/review-contract-fixture']);
  return { root, baseOid, nextCommit: 1 };
}

function cloneFixtureRepository(repository) {
  const parent = mkdtempSync(join(tmpdir(), 'autoloop-review-contract-clone-'));
  const root = join(parent, 'repository');
  FIXTURE_REPOSITORIES.add(parent);
  execFileSync(
    'git',
    ['clone', '--no-hardlinks', '--branch', 'feature/review-contract-fixture',
      repository.root, root],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
    },
  );
  fixtureGit(root, ['config', 'user.name', 'Autoloop Review Contract']);
  fixtureGit(root, ['config', 'user.email', 'review-contract@example.invalid']);
  fixtureGit(root, [
    'remote',
    'set-url',
    'origin',
    `https://github.com/autoloop-fixtures/review-${randomUUID()}.git`,
  ]);
  return { root, baseOid: repository.baseOid, nextCommit: repository.nextCommit };
}

function commitFixtureRound(repository, round) {
  writeFileSync(
    join(repository.root, 'reviewed.txt'),
    `round ${round}\n${'review evidence\n'.repeat(round)}`,
    'utf8',
  );
  fixtureGit(repository.root, ['add', '--', 'reviewed.txt']);
  fixtureGit(
    repository.root,
    ['commit', '-m', `test: create review round ${repository.nextCommit}`],
  );
  repository.nextCommit += 1;
  return fixtureGit(repository.root, ['rev-parse', 'HEAD']);
}

function cleanupFixtureRepositories() {
  for (const root of FIXTURE_REPOSITORIES) {
    rmSync(root, { recursive: true, force: true });
  }
  FIXTURE_REPOSITORIES.clear();
}

function fixtureReceiptFactory(projectConfig = fixtureProjectConfig()) {
  const primaryRepository = createFixtureRepository();
  const hostEvidence = issueHostEvidence({
    integration: 'review-contract-self-test',
    sessionId: 'review-contract-session',
    observedSurface: { host: 'claude' },
    expectedHost: 'claude',
  });
  if (!hostEvidence.ok) throw new Error('host fixture did not attest');
  const opened = open({
    invocation: '/autoloop:dev',
    intentProvenance: INTENT_PROVENANCE,
    hostEvidence: hostEvidence.value,
    config: projectConfig,
  });
  if (!opened.ok) throw new Error('run fixture did not open');
  const run = opened.value;
  const observations = CAPABILITY_REQUIREMENTS.map((requirement) => ({
    requirement,
    available: true,
    source: 'review-contract-self-test',
    evidenceFingerprint: fixtureHash({ requirement, available: true }),
  }));
  let capabilities = null;
  let routeState = null;
  let previousHead = null;
  let previousVerdict = null;
  let previousSource = null;
  return (round, verdict, options = {}) => {
    const artifactVersion = options.artifactVersion ?? round;
    const repository = options.switchRepository === true
      ? cloneFixtureRepository(primaryRepository)
      : primaryRepository;
    const headOid = commitFixtureRound(repository, round);
    const baseOid = repository.baseOid;
    const checkout = snapshotExecutionCheckout(repository.root);
    if (checkout === null) throw new Error('checkout fixture did not snapshot');
    const nextCapabilities = issueCapabilitySnapshot({
      hostEvidence: hostEvidence.value,
      invocationNonce: run.invocationNonce,
      checkout,
      observations,
    });
    if (!nextCapabilities.ok) {
      throw new Error('capability fixture did not attest');
    }
    if (capabilities === null) {
      const initialized = initializeRouteState({
        run,
        capabilities: nextCapabilities.value,
      });
      if (!initialized.ok) {
        throw new Error('route-state fixture did not initialize');
      }
      routeState = initialized.value;
    } else {
      const refreshed = refreshRouteState({
        run,
        routeState,
        previousCapabilities: capabilities,
        capabilities: nextCapabilities.value,
      });
      if (!refreshed.ok) {
        throw new Error('route-state fixture did not refresh');
      }
      routeState = refreshed.value;
    }
    capabilities = nextCapabilities.value;
    const autoPriorFindings = [];
    const ledger = new Map(
      (previousSource?.priorFindings ?? []).map(
        (finding) => [finding.findingId, structuredClone(finding)],
      ),
    );
    if (previousVerdict !== null) {
      const previousGating = new Map(
        gatingFindings(previousVerdict).map((finding) => [finding.id, finding]),
      );
      const previousRebuts = new Map(
        previousVerdict.rebuts.map((rebut) => [rebut.findingId, rebut]),
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
            ? 'The author supplied a bounded authenticated rebuttal.'
            : 'The exact sealed delta contains the bounded fix.',
        });
      }
    }
    autoPriorFindings.push(...ledger.values());
    const source = {
      kind: 'git-review',
      configuredBaseOid: baseOid,
      finalHeadOid: headOid,
      deltaBaseOid:
        options.deltaBaseOid === 'configured-base'
          ? baseOid
          : options.deltaBaseOid
        ?? (round === 1 ? baseOid : previousHead),
      priorFindings:
        options.priorFindings
        ?? autoPriorFindings,
      openRebuttals: options.openRebuttals ?? verdict.rebuts.map(({ findingId }) => ({
        findingId,
        claim: `Re-evaluate ${findingId} against the sealed fix delta.`,
        evidence: `Authenticated rebut evidence for ${findingId}.`,
      })),
    };
    const artifactFingerprint = artifactSourceFingerprint({
      stage: 'code-review',
      artifactVersion,
      source,
    });
    const laneProof = classifyLaneProof({
      mode: 'final',
      configuredBase: { ref: 'origin/main', oid: baseOid },
      subject: { kind: 'head', headOid },
      final: {
        complete: true,
        changedFiles: 1,
        files: [{
          status: 'M',
          path: '.githooks/pre-push',
          additions: 2,
          deletions: 1,
          contentRead: true,
        }],
        persistedData: false,
      },
    });
    if (laneProof.lane !== 'full') throw new Error('lane fixture did not classify');
    const planned = plan({
      run,
      config: projectConfig,
      capabilities,
      routeState,
      laneProof,
      work: {
        flow: 'dev',
        stage: 'code-review',
        round,
        planReviewDispatches: 1,
        configuredBaseOid: baseOid,
        checkout,
        artifact: {
          kind: 'code',
          version: artifactVersion,
          fingerprint: artifactFingerprint,
          authorIdentity: options.authorIdentity ?? `author-${artifactVersion}`,
          reviewerIdentity: options.reviewerIdentity ?? 'reviewer',
          headOid,
          source,
        },
        concurrency: {
          activeWriters: 0,
          stagedAhead: 0,
          stagedAheadReadOnly: true,
        },
      },
    });
    if (!planned.ok) {
      throw new Error(`review fixture did not plan: ${JSON.stringify(planned)}`);
    }
    const attempt = compileRouteAttempt(planned.value);
    if (!attempt.ok) throw new Error('review fixture did not compile');
    const evidence = issueHostAttemptReceipt({
      attempt: attempt.value,
      raw: {
        producer: attempt.value.producer,
        status: 'succeeded',
        effect: 'none',
        launchStatus: 'launched',
        isolation: {
          mode: planned.value.isolation.mode,
          verified: true,
          fingerprint: '6'.repeat(64),
        },
        executionEvidence: {
          kind: 'process',
          instanceId:
            options.executionInstanceId ?? `review-child-${round}`,
          integration: attempt.value.producer,
          transcriptFingerprint: fixtureHash({
            round,
            kind: 'transcript',
          }),
        },
        modelIdentity: 'review/model',
        verdict,
      },
    });
    if (!evidence.ok) {
      throw new Error(
        `review fixture evidence did not issue: ${JSON.stringify(evidence)}`,
      );
    }
    const outcome = classifyRouteAttempt({
      attempt: attempt.value,
      evidence: evidence.value,
    });
    if (!outcome.ok) throw new Error('review fixture evidence did not classify');
    const observed = observe({
      run,
      routeState,
      plan: planned.value,
      outcome: outcome.value,
    });
    if (!observed.ok || observed.value.kind !== 'complete') {
      throw new Error('review fixture did not complete');
    }
    routeState = observed.value.routeState;
    previousHead = headOid;
    previousVerdict = verdict;
    previousSource = observed.value.receipt.artifactSource;
    return observed.value.receipt;
  };
}

function inputFor(
  receipts,
  projectConfig = fixtureProjectConfig(),
  overrides = {},
) {
  const current = receipts.at(-1);
  const verdict = current.reviewVerdicts[0].verdict;
  return {
    round: receipts.length,
    scope: receipts.length === 1 ? 'full' : 'delta',
    projectConfig,
    expected: {
      runInstanceFingerprint: current.runInstanceFingerprint,
      planFingerprint: current.planFingerprint,
      repositoryFingerprint: current.checkout.repositoryFingerprint,
      configuredBaseOid: current.configuredBaseOid,
      artifactVersion: current.artifactVersion,
      artifactFingerprint: current.artifactFingerprint,
      headOid: current.artifactSubject.headOid,
    },
    findingAnnotations: verdict.findings.map(({ id }) => ({
      id,
      verified: true,
      inScope: true,
    })),
    runtimeReceipts: receipts,
    ...overrides,
  };
}

function selfTest() {
  const clean = fixtureReceiptFactory()(1, {
    verdict: 'pass',
    findings: [],
    rebuts: [],
  });
  const finding = {
    id: 'finding-1',
    severity: 'Major',
    summary: 'A gating defect remains',
    evidence: 'src/reviewed.mjs:1',
  };
  const acceptedFactory = fixtureReceiptFactory();
  const acceptedFirstFailure = acceptedFactory(1, {
    verdict: 'fail',
    findings: [finding],
    rebuts: [],
  });
  const accepted = acceptedFactory(2, {
    verdict: 'pass',
    findings: [],
    rebuts: [{
      findingId: finding.id,
      status: 'accepted',
      evidence: 'The authenticated fix closes the finding.',
    }],
  });
  const fixedFactory = fixtureReceiptFactory();
  const fixedFirstFailure = fixedFactory(1, {
    verdict: 'fail',
    findings: [finding],
    rebuts: [],
  });
  const fixed = fixedFactory(2, {
    verdict: 'pass',
    findings: [],
    rebuts: [],
  });
  const rejectedFactory = fixtureReceiptFactory();
  const rejectedFirstFailure = rejectedFactory(1, {
    verdict: 'fail',
    findings: [finding],
    rebuts: [],
  });
  const rejectedFinding = {
    ...finding,
  };
  const rejected = rejectedFactory(2, {
    verdict: 'fail',
    findings: [rejectedFinding],
    rebuts: [{
      findingId: finding.id,
      status: 'rejected',
      evidence: 'The supplied evidence does not close the finding.',
    }],
  });
  const lateFinding = {
    id: 'late-major',
    severity: 'Major',
    summary: 'A late gating defect exists outside the fix delta',
    evidence: 'src/other.mjs:3',
  };
  const lateFactory = fixtureReceiptFactory();
  const lateClean = lateFactory(1, {
    verdict: 'pass',
    findings: [],
    rebuts: [],
  });
  const late = lateFactory(2, {
    verdict: 'fail',
    findings: [lateFinding],
    rebuts: [],
  });
  const configuredCap = fixtureProjectConfig(1);
  const cappedFailure = fixtureReceiptFactory(configuredCap)(1, {
    verdict: 'fail',
    findings: [finding],
    rebuts: [],
  });
  const wrongDeltaFactory = fixtureReceiptFactory();
  const wrongDeltaFirst = wrongDeltaFactory(1, {
    verdict: 'fail',
    findings: [finding],
    rebuts: [],
  });
  const wrongDelta = wrongDeltaFactory(2, {
    verdict: 'pass',
    findings: [],
    rebuts: [{
      findingId: finding.id,
      status: 'accepted',
      evidence: 'The wrong range cannot authenticate convergence.',
    }],
  }, {
    deltaBaseOid: 'configured-base',
  });
  const omittedLedgerFactory = fixtureReceiptFactory();
  const omittedLedgerFirst = omittedLedgerFactory(1, {
    verdict: 'fail',
    findings: [finding],
    rebuts: [],
  });
  const omittedLedger = omittedLedgerFactory(2, {
    verdict: 'pass',
    findings: [],
    rebuts: [],
  }, {
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
  const reusedInstanceFactory = fixtureReceiptFactory();
  const reusedInstanceFirst = reusedInstanceFactory(1, {
    verdict: 'fail',
    findings: [finding],
    rebuts: [],
  });
  const reusedInstance = reusedInstanceFactory(2, {
    verdict: 'pass',
    findings: [],
    rebuts: [{
      findingId: finding.id,
      status: 'accepted',
      evidence: 'A repeated host-child instance is not a fresh review.',
    }],
  }, {
    executionInstanceId: 'review-child-1',
  });
  const switchedRepositoryFactory = fixtureReceiptFactory();
  const switchedRepositoryFirst = switchedRepositoryFactory(1, {
    verdict: 'fail',
    findings: [finding],
    rebuts: [],
  });
  const switchedRepository = switchedRepositoryFactory(2, {
    verdict: 'pass',
    findings: [],
    rebuts: [{
      findingId: finding.id,
      status: 'accepted',
      evidence: 'A different repository cannot continue this review chain.',
    }],
  }, {
    switchRepository: true,
  });
  const cumulativeFinding = {
    id: 'finding-2',
    severity: 'Major',
    summary: 'A later delta introduces another gating defect',
    evidence: 'src/reviewed.mjs:2',
  };
  const cumulativeFactory = fixtureReceiptFactory();
  const cumulativeFirst = cumulativeFactory(1, {
    verdict: 'fail',
    findings: [finding],
    rebuts: [],
  });
  const cumulativeSecond = cumulativeFactory(2, {
    verdict: 'fail',
    findings: [cumulativeFinding],
    rebuts: [],
  });
  const cumulativeThird = cumulativeFactory(3, {
    verdict: 'pass',
    findings: [],
    rebuts: [],
  });
  const omittedHistoryFactory = fixtureReceiptFactory();
  const omittedHistoryFirst = omittedHistoryFactory(1, {
    verdict: 'fail',
    findings: [finding],
    rebuts: [],
  });
  const omittedHistorySecond = omittedHistoryFactory(2, {
    verdict: 'fail',
    findings: [cumulativeFinding],
    rebuts: [],
  });
  const omittedHistoryThird = omittedHistoryFactory(3, {
    verdict: 'pass',
    findings: [],
    rebuts: [],
  }, {
    priorFindings: [{
      findingId: cumulativeFinding.id,
      severity: cumulativeFinding.severity,
      summary: cumulativeFinding.summary,
      evidence: cumulativeFinding.evidence,
      disposition: 'fix',
      state: 'open',
      rationale: 'The exact sealed delta contains the bounded fix.',
    }],
  });
  const mutatedHistoryFactory = fixtureReceiptFactory();
  const mutatedHistoryFirst = mutatedHistoryFactory(1, {
    verdict: 'fail',
    findings: [finding],
    rebuts: [],
  });
  const mutatedHistorySecond = mutatedHistoryFactory(2, {
    verdict: 'fail',
    findings: [cumulativeFinding],
    rebuts: [],
  });
  const mutatedHistoryThird = mutatedHistoryFactory(3, {
    verdict: 'pass',
    findings: [],
    rebuts: [],
  }, {
    priorFindings: [
      {
        findingId: finding.id,
        severity: finding.severity,
        summary: 'The historical finding was silently rewritten.',
        evidence: finding.evidence,
        disposition: 'fix',
        state: 'closed',
        rationale: 'The exact sealed delta contains the bounded fix.',
      },
      {
        findingId: cumulativeFinding.id,
        severity: cumulativeFinding.severity,
        summary: cumulativeFinding.summary,
        evidence: cumulativeFinding.evidence,
        disposition: 'fix',
        state: 'open',
        rationale: 'The exact sealed delta contains the bounded fix.',
      },
    ],
  });

  const cases = [
    {
      name: 'authenticated clean full review publishes success',
      input: inputFor([clean]),
      expected: ['clean', true],
    },
    {
      name: 'authenticated Major continues below the cap',
      input: inputFor([acceptedFirstFailure]),
      expected: ['continue', false],
    },
    {
      name: 'authenticated accepted rebut permits clean result',
      input: inputFor([acceptedFirstFailure, accepted]),
      expected: ['clean', true],
    },
    {
      name: 'authenticated reviewed fix permits clean result',
      input: inputFor([fixedFirstFailure, fixed]),
      expected: ['clean', true],
    },
    {
      name: 'authenticated rejected rebut continues',
      input: inputFor([rejectedFirstFailure, rejected]),
      expected: ['continue', false],
    },
    {
      name: 'verified out-of-delta Major blocks for a human',
      input: {
        ...inputFor([lateClean, late]),
        findingAnnotations: [{
          id: lateFinding.id,
          verified: true,
          inScope: false,
        }],
      },
      expected: ['human-block', false],
    },
    {
      name: 'unverified gating finding requires verification',
      input: {
        ...inputFor([acceptedFirstFailure]),
        findingAnnotations: [{
          id: finding.id,
          verified: false,
          inScope: true,
        }],
      },
      expected: ['verify', false],
    },
    {
      name: 'gating finding at cap blocks',
      input: inputFor([cappedFailure], configuredCap),
      expected: ['human-block', false],
    },
    {
      name: 'caller cannot inflate the configured review cap',
      input: {
        ...inputFor([acceptedFirstFailure]),
        projectConfig: {
          ...fixtureProjectConfig(),
          caps: {
            ...fixtureProjectConfig().caps,
            codeReviewRoundsPerUnit: 20,
          },
        },
      },
      expected: ['error', false],
    },
    {
      name: 'caller-authored rebut status has no accepted input field',
      input: {
        ...inputFor([rejectedFirstFailure, rejected]),
        rebutRequests: [{
          findingId: finding.id,
          status: 'accepted',
        }],
      },
      expected: ['error', false],
    },
    {
      name: 'authenticated delta must start at the preceding reviewed head',
      input: inputFor([wrongDeltaFirst, wrongDelta]),
      expected: ['error', false],
    },
    {
      name: 'authenticated later-round ledger cannot omit a prior Major',
      input: inputFor([omittedLedgerFirst, omittedLedger]),
      expected: ['error', false],
    },
    {
      name: 'review rounds require distinct authenticated execution instances',
      input: inputFor([reusedInstanceFirst, reusedInstance]),
      expected: ['error', false],
    },
    {
      name: 'review history cannot switch repositories',
      input: inputFor([switchedRepositoryFirst, switchedRepository]),
      expected: ['error', false],
    },
    {
      name: 'three-round review retains closed and open cumulative findings',
      input: inputFor([
        cumulativeFirst,
        cumulativeSecond,
        cumulativeThird,
      ]),
      expected: ['clean', true],
    },
    {
      name: 'three-round review cannot omit a resolved historical finding',
      input: inputFor([
        omittedHistoryFirst,
        omittedHistorySecond,
        omittedHistoryThird,
      ]),
      expected: ['error', false],
    },
    {
      name: 'three-round review cannot rewrite historical finding evidence',
      input: inputFor([
        mutatedHistoryFirst,
        mutatedHistorySecond,
        mutatedHistoryThird,
      ]),
      expected: ['error', false],
    },
    {
      name: 'forged verdict fails after recomputing public receipt hash',
      input: (() => {
        const forged = structuredClone(acceptedFirstFailure);
        forged.reviewVerdicts[0].verdict.findings = [];
        forged.reviewVerdicts[0].verdict.verdict = 'pass';
        forged.attempts.at(-1).verdict = forged.reviewVerdicts[0].verdict;
        const unsigned = { ...forged };
        delete unsigned.fingerprint;
        forged.fingerprint = hashValue(unsigned);
        return inputFor([forged]);
      })(),
      expected: ['error', false],
    },
    {
      name: 'stale expected head cannot replay an authentic receipt',
      input: {
        ...inputFor([clean]),
        expected: {
          ...inputFor([clean]).expected,
          headOid: 'f'.repeat(40),
        },
      },
      expected: ['error', false],
    },
    {
      name: 'stale expected repository cannot replay an authentic receipt',
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
      name: 'receipt history cannot skip a review round',
      input: {
        ...inputFor([acceptedFirstFailure, accepted]),
        runtimeReceipts: [accepted],
      },
      expected: ['error', false],
    },
    {
      name: 'round one cannot claim delta scope',
      input: {
        ...inputFor([clean]),
        scope: 'delta',
      },
      expected: ['error', false],
    },
    {
      name: 'null finding annotation is rejected without throwing',
      input: {
        ...inputFor([clean]),
        findingAnnotations: [null],
      },
      expected: ['error', false],
    },
    {
      name: 'full review cannot classify a finding out of scope',
      input: (() => {
        const failingFull = fixtureReceiptFactory()(1, {
          verdict: 'fail',
          findings: [{
            id: 'full-major',
            severity: 'Major',
            summary: 'A full-review finding',
            evidence: 'src/reviewed.mjs:4',
          }],
          rebuts: [],
        });
        const standalone = inputFor([failingFull]);
        standalone.findingAnnotations[0].inScope = false;
        return standalone;
      })(),
      expected: ['error', false],
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
  const oldHead = clean.artifactSubject.headOid;
  const cleanCheckout = clean.checkout;
  const publicationCases = [
    {
      name: 'authenticated clean receipt authorizes only its reviewed head',
      actual: authorizeReviewPublication(
        cleanInput,
        oldHead,
        cleanCheckout,
      ).authorized,
      expected: true,
    },
    {
      name: 'authenticated old receipt cannot authorize a different current head',
      actual: authorizeReviewPublication(
        cleanInput,
        'f'.repeat(40),
        cleanCheckout,
      ).authorized,
      expected: false,
    },
    {
      name: 'authenticated review cannot publish from a different live checkout',
      actual: authorizeReviewPublication(
        cleanInput,
        oldHead,
        {
          ...cleanCheckout,
          repositoryFingerprint: 'f'.repeat(64),
        },
      ).authorized,
      expected: false,
    },
    {
      name: 'authenticated review cannot publish from a dirty live checkout',
      actual: authorizeReviewPublication(
        cleanInput,
        oldHead,
        {
          ...cleanCheckout,
          clean: false,
        },
      ).authorized,
      expected: false,
    },
    {
      name: 'invalid review evidence fails publication without throwing',
      actual: authorizeReviewPublication(
        {
          ...cleanInput,
          round: null,
        },
        oldHead,
        cleanCheckout,
      ).authorized,
      expected: false,
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
  if (process.argv.includes('--self-test')) {
    let passed;
    try {
      passed = selfTest();
    } finally {
      cleanupFixtureRepositories();
    }
    process.exit(passed ? 0 : 1);
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
