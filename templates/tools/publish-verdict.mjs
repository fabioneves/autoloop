#!/usr/bin/env node
// SHA-bound CheckRun publisher. Posts verdicts and typed attestations through the
// caller's GitHub App identity so the merge gate can authenticate head and producer.
//
// Deliberately narrow:
//   - closed agentic context enum
//   - only `success` can be posted; absence is the failure signal
//   - gate executes the configured command itself on the exact clean checkout
//   - ownership, policy, and human authorization require a strict attestation file
//   - review requires authenticated convergence plus the exact clean live checkout
//   - details arrive through a file, never shell arguments
//
// Usage: node tools/agentic/publish-verdict.mjs <context> <40-hex sha>
//        [--attestation-file <path> | --review-evidence-file <path>]
//        [--expect-app-id <positive integer>]

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  serializeAttestation,
  validateAttestation,
} from './attestation-contract.mjs';
import {
  extractConfig,
  validateConfig,
} from './config-contract.mjs';
import { authorizeReviewPublication } from './review-contract.mjs';
import { snapshotExecutionRepository } from './route-adapter-contract.mjs';

const CONTEXTS = new Set([
  'gate',
  'review',
  'ownership',
  'policy',
  'human-authorization',
]);
const ATTESTATION_CONTEXTS = new Set(['ownership', 'policy', 'human-authorization']);
const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_REVIEW_EVIDENCE_BYTES = 32 * 1024 * 1024;
const MAX_AUXILIARY_EVIDENCE_BYTES = 1024 * 1024;
const REPOSITORY_PART_RE =
  /^[a-z0-9](?:[a-z0-9._-]{0,99})$/;
const HOST_RE =
  /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;

function readBoundedNoFollow(path, maximum) {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.size > maximum) {
      throw new Error(`evidence file must be a regular file of at most ${maximum} bytes`);
    }
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function reviewSummary(
  evidence,
  sha,
  liveCheckout,
  authorizer = authorizeReviewPublication,
) {
  const authorization = authorizer(evidence, sha, liveCheckout);
  if (!authorization.authorized) {
    throw new Error(
      `review evidence is not clean and live-checkout-bound (${authorization.code})`,
    );
  }
  return (
    `Authenticated review convergence: ${authorization.code}; `
    + `round ${evidence.round}; receipt `
    + `${authorization.runtimeReceiptFingerprint}.`
  );
}

export function buildCheckRun(ctx, sha, summary, completedAt = new Date().toISOString()) {
  const text = typeof summary === 'string' && summary.length > 0
    ? summary.slice(0, 65535)
    : 'Verified by the Autoloop development workflow.';
  return {
    name: `agentic/${ctx}`,
    head_sha: sha,
    status: 'completed',
    conclusion: 'success',
    started_at: completedAt,
    completed_at: completedAt,
    output: {
      title: `Autoloop ${ctx} passed`,
      summary: text,
    },
  };
}

export function hasTrustedProducer(checkRun, trustedAppIds) {
  return (
    Array.isArray(trustedAppIds)
    && trustedAppIds.some((id) => Number.isInteger(id) && id > 0 && id === checkRun?.app?.id)
  );
}

export function buildGitHubApiArgs(repository) {
  if (
    repository === null
    || typeof repository !== 'object'
    || Array.isArray(repository)
    || Object.keys(repository).sort().join(',') !== 'host,owner,repo'
    || !HOST_RE.test(repository.host ?? '')
    || !REPOSITORY_PART_RE.test(repository.owner ?? '')
    || !REPOSITORY_PART_RE.test(repository.repo ?? '')
  ) {
    throw new Error('publication repository target is invalid');
  }
  return [
    'api',
    '--hostname',
    repository.host,
    `repos/${repository.owner}/${repository.repo}/check-runs`,
    '--method',
    'POST',
    '-H',
    'Accept: application/vnd.github+json',
    '-H',
    'X-GitHub-Api-Version: 2026-03-10',
    '--input',
    '-',
  ];
}

function samePublicationSnapshot(left, right) {
  if (
    left?.checkout === undefined
    || right?.checkout === undefined
    || left?.repository === undefined
    || right?.repository === undefined
  ) {
    return false;
  }
  return (
    left.checkout.root === right.checkout.root
    && left.checkout.repositoryFingerprint
      === right.checkout.repositoryFingerprint
    && left.checkout.branch === right.checkout.branch
    && left.checkout.headOid === right.checkout.headOid
    && left.checkout.clean === right.checkout.clean
    && left.repository?.host === right.repository?.host
    && left.repository.owner === right.repository.owner
    && left.repository.repo === right.repository.repo
  );
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function gateSummary(config, sha, before, after, result) {
  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new Error(`ProjectConfig is invalid: ${errors.join('; ')}`);
  }
  if (
    before?.checkout?.headOid !== sha
    || before.checkout.clean !== true
    || after?.checkout?.headOid !== sha
    || after.checkout.clean !== true
    || !samePublicationSnapshot(before, after)
  ) {
    throw new Error('gate checkout is not the exact unchanged clean requested head');
  }
  if (result?.error || result?.signal || result?.status !== 0) {
    throw new Error(
      `configured gate did not exit 0`
      + (result?.signal ? ` (signal ${result.signal})` : '')
      + (Number.isInteger(result?.status) ? ` (exit ${result.status})` : ''),
    );
  }
  return serializeAttestation({
    kind: 'gate',
    v: 1,
    headOid: sha,
    commandHash: sha256(config.gate.command),
    configHash: sha256(JSON.stringify(config)),
    repositoryFingerprint: after.checkout.repositoryFingerprint,
  });
}

function runGate(command, cwd) {
  return spawnSync(command, {
    cwd,
    env: process.env,
    shell: true,
    stdio: 'inherit',
  });
}

// Pure arg validation — closed context enum + lowercase 40-hex SHA. Exported for --self-test.
export function validateArgs(ctx, sha) {
  if (!CONTEXTS.has(ctx)) return { ok: false, error: `context must be one of: ${[...CONTEXTS].join(', ')}` };
  if (!SHA_RE.test(sha ?? '')) return { ok: false, error: 'second arg must be the full 40-hex (lowercase) gated SHA (git rev-parse HEAD)' };
  return { ok: true };
}

export function parseArgs(args) {
  const [ctx, sha, ...rest] = args;
  const parsed = {
    ctx,
    sha,
    summaryFile: null,
    attestationFile: null,
    reviewEvidenceFile: null,
    expectedAppId: null,
    selfTest: args.length === 1 && args[0] === '--self-test',
    error: null,
  };
  if (parsed.selfTest) return parsed;
  const valid = validateArgs(ctx, sha);
  if (!valid.ok) {
    parsed.error = valid.error;
    return parsed;
  }
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (flag === '--summary-file' && parsed.summaryFile === null && value && !value.startsWith('-')) {
      parsed.summaryFile = value;
      index += 1;
      continue;
    }
    if (
      flag === '--attestation-file'
      && parsed.attestationFile === null
      && value
      && !value.startsWith('-')
    ) {
      parsed.attestationFile = value;
      index += 1;
      continue;
    }
    if (
      flag === '--review-evidence-file'
      && parsed.reviewEvidenceFile === null
      && value
      && !value.startsWith('-')
    ) {
      parsed.reviewEvidenceFile = value;
      index += 1;
      continue;
    }
    if (flag === '--expect-app-id' && parsed.expectedAppId === null && /^\d+$/.test(value ?? '')) {
      parsed.expectedAppId = Number(value);
      if (!Number.isSafeInteger(parsed.expectedAppId) || parsed.expectedAppId < 1) {
        parsed.error = '--expect-app-id must be a positive safe integer';
        return parsed;
      }
      index += 1;
      continue;
    }
    parsed.error = `unknown, duplicate, or incomplete option: ${flag ?? 'missing'}`;
    return parsed;
  }
  if (ATTESTATION_CONTEXTS.has(ctx)) {
    if (
      parsed.attestationFile === null
      || parsed.summaryFile !== null
      || parsed.reviewEvidenceFile !== null
    ) {
      parsed.error =
        `${ctx} requires --attestation-file and forbids other evidence files`;
    }
  } else if (ctx === 'review') {
    if (
      parsed.reviewEvidenceFile === null
      || parsed.summaryFile !== null
      || parsed.attestationFile !== null
    ) {
      parsed.error =
        'review requires --review-evidence-file and forbids other evidence files';
    }
  } else if (ctx === 'gate') {
    if (
      parsed.summaryFile !== null
      || parsed.attestationFile !== null
      || parsed.reviewEvidenceFile !== null
    ) {
      parsed.error = 'gate executes cfg.gate.command and forbids caller-authored evidence';
    }
  }
  return parsed;
}

function selfTest() {
  const cases = [
    [['gate', 'a'.repeat(40)], true],
    [['review', 'a'.repeat(40)], true],
    [['ownership', 'a'.repeat(40)], true],
    [['policy', 'a'.repeat(40)], true],
    [['human-authorization', 'a'.repeat(40)], true],
    [['deploy', 'a'.repeat(40)], false], // context outside the closed enum
    [[undefined, 'a'.repeat(40)], false],
    [['gate', 'a'.repeat(39)], false], // too short
    [['gate', 'a'.repeat(41)], false], // too long
    [['gate', 'A'.repeat(40)], false], // uppercase rejected — git SHAs are lowercase
    [['gate', 'g'.repeat(40)], false], // non-hex
    [['gate', undefined], false],
  ];
  let passed = 0;
  for (const [[ctx, sha], expect] of cases) {
    if (validateArgs(ctx, sha).ok === expect) {
      passed += 1;
    } else {
      console.error(`FAIL [expect ${expect}]: ctx=${ctx} sha=${String(sha).slice(0, 8)}`);
    }
  }
  const payload = buildCheckRun('gate', 'a'.repeat(40), 'gate passed', '2026-07-24T00:00:00.000Z');
  if (
    payload.name !== 'agentic/gate'
    || payload.head_sha !== 'a'.repeat(40)
    || payload.status !== 'completed'
    || payload.conclusion !== 'success'
    || payload.completed_at !== '2026-07-24T00:00:00.000Z'
  ) {
    console.error('FAIL verdict publishes as a completed CheckRun');
  } else passed += 1;
  if (hasTrustedProducer({ app: { id: 42, slug: 'autoloop-verdicts' } }, [42])) {
    passed += 1;
  } else {
    console.error('FAIL configured GitHub App producer is accepted');
  }
  if (!hasTrustedProducer({ app: { id: 7, slug: 'unknown' } }, [42])) {
    passed += 1;
  } else {
    console.error('FAIL unconfigured producer is rejected');
  }
  const parsed = parseArgs([
    'review',
    'a'.repeat(40),
    '--review-evidence-file',
    '/tmp/review.json',
    '--expect-app-id',
    '42',
  ]);
  if (
    !parsed.error
    && parsed.reviewEvidenceFile === '/tmp/review.json'
    && parsed.expectedAppId === 42
  ) {
    passed += 1;
  } else {
    console.error('FAIL closed CLI options parse');
  }
  const inline = parseArgs(['gate', 'a'.repeat(40), 'untrusted inline summary']);
  if (inline.error) passed += 1;
  else console.error('FAIL inline summary is rejected');
  const attestationArgs = parseArgs([
    'ownership',
    'a'.repeat(40),
    '--attestation-file',
    '/tmp/ownership.json',
  ]);
  if (!attestationArgs.error && attestationArgs.attestationFile === '/tmp/ownership.json') {
    passed += 1;
  } else {
    console.error('FAIL ownership attestation args parse');
  }
  if (parseArgs(['policy', 'a'.repeat(40)]).error) passed += 1;
  else console.error('FAIL policy requires an attestation file');
  if (parseArgs([
    'gate',
    'a'.repeat(40),
    '--attestation-file',
    '/tmp/gate.json',
  ]).error) passed += 1;
  else console.error('FAIL gate rejects an attestation file');
  if (parseArgs([
    'gate',
    'a'.repeat(40),
    '--summary-file',
    '/tmp/gate.txt',
  ]).error) passed += 1;
  else console.error('FAIL gate rejects caller-authored summary evidence');
  if (parseArgs(['review', 'a'.repeat(40)]).error) passed += 1;
  else console.error('FAIL review requires authenticated transition evidence');
  if (parseArgs([
    'review',
    'a'.repeat(40),
    '--summary-file',
    '/tmp/review.txt',
  ]).error) passed += 1;
  else console.error('FAIL review rejects caller-authored summary evidence');
  const ownership = {
    kind: 'ownership',
    v: 1,
    headOid: 'a'.repeat(40),
    issue: 7,
    issueBodyHash: 'b'.repeat(64),
    claimCommitOid: 'c'.repeat(40),
    frozenPlanHash: 'd'.repeat(64),
    frozenPlanCommentId: 'IC_kwDOAutoloop7',
    frozenPlanAuthor: 'autoloop[bot]',
  };
  if (
    validateAttestation(ownership, {
      kind: 'ownership',
      headOid: ownership.headOid,
    }).length === 0
    && buildCheckRun(
      'ownership',
      ownership.headOid,
      serializeAttestation(ownership),
      '2026-07-24T00:00:00.000Z',
    ).name === 'agentic/ownership'
  ) {
    passed += 1;
  } else {
    console.error('FAIL ownership attestation builds a CheckRun');
  }
  const authorization = {
    kind: 'human-authorization',
    v: 1,
    headOid: 'a'.repeat(40),
    pullRequest: 12,
    actor: 'maintainer',
    label: 'risk:pure-deletion',
    labelEventId: 123456,
    labeledAt: '2026-07-24T00:00:00Z',
  };
  if (
    buildCheckRun(
      'human-authorization',
      authorization.headOid,
      serializeAttestation(authorization),
      '2026-07-24T00:00:00.000Z',
    ).output.summary.includes('"labelEventId":123456')
  ) {
    passed += 1;
  } else {
    console.error('FAIL human authorization publishes immutable label-event identity');
  }
  const reviewCheckout = {
    root: '/repo',
    repositoryFingerprint: 'b'.repeat(64),
    branch: 'feature/review',
    headOid: 'a'.repeat(40),
    clean: true,
  };
  let forwardedCheckout = null;
  const reviewConsumerSummary = reviewSummary(
    { round: 2 },
    reviewCheckout.headOid,
    reviewCheckout,
    (_evidence, _sha, checkout) => {
      forwardedCheckout = checkout;
      return {
        authorized: true,
        code: 'REVIEW_CLEAN',
        runtimeReceiptFingerprint: 'c'.repeat(64),
      };
    },
  );
  if (
    forwardedCheckout === reviewCheckout
    && reviewConsumerSummary.includes('round 2')
    && reviewConsumerSummary.includes('c'.repeat(64))
  ) {
    passed += 1;
  } else {
    console.error('FAIL review publisher forwards live checkout to the authorizer');
  }
  try {
    reviewSummary(
      { round: 1 },
      reviewCheckout.headOid,
      reviewCheckout,
      () => ({
        authorized: false,
        code: 'INVALID_REVIEW_EVIDENCE',
        runtimeReceiptFingerprint: null,
      }),
    );
    console.error('FAIL review publisher rejects denied authorization');
  } catch {
    passed += 1;
  }
  const originalGhRepo = process.env.GH_REPO;
  try {
    process.env.GH_REPO = 'attacker/redirect';
    const apiArgs = buildGitHubApiArgs({
      host: 'github.example.com',
      owner: 'autoloop',
      repo: 'review-fixture',
    });
    if (
      apiArgs[1] === '--hostname'
      && apiArgs[2] === 'github.example.com'
      && apiArgs[3] === 'repos/autoloop/review-fixture/check-runs'
      && !apiArgs.join(' ').includes('attacker')
      && !apiArgs.join(' ').includes('{owner}')
    ) {
      passed += 1;
    } else {
      console.error('FAIL publication uses the explicit validated repository target');
    }
  } finally {
    if (originalGhRepo === undefined) delete process.env.GH_REPO;
    else process.env.GH_REPO = originalGhRepo;
  }
  try {
    buildGitHubApiArgs({
      host: 'github.com',
      owner: '../attacker',
      repo: 'review-fixture',
    });
    console.error('FAIL publication rejects an invalid repository target');
  } catch {
    passed += 1;
  }
  const gateConfig = {
    version: '0.25.0',
    baseBranch: 'main',
    gate: { command: 'npm test', quickCommand: null, setupCommand: null },
    merge: { policy: 'manual' },
    tracker: { provider: 'none' },
    review: { checklistPath: 'docs/agentic/checklist.md' },
    caps: {
      gateRetriesPerUnit: 2,
      reviseRoundsPerPr: 3,
      codeReviewRoundsPerUnit: 5,
      sliceMaxLines: 700,
      sliceMaxFiles: 10,
    },
  };
  const gateSnapshot = {
    checkout: {
      root: '/repo',
      repositoryFingerprint: 'b'.repeat(64),
      branch: 'feature/gate',
      headOid: 'a'.repeat(40),
      clean: true,
    },
    repository: {
      host: 'github.com',
      owner: 'autoloop',
      repo: 'fixture',
    },
  };
  const gateEvidence = gateSummary(
    gateConfig,
    gateSnapshot.checkout.headOid,
    gateSnapshot,
    structuredClone(gateSnapshot),
    { status: 0, signal: null, error: null },
  );
  if (
    gateEvidence.includes('"kind":"gate"')
    && gateEvidence.includes(`"commandHash":"${sha256(gateConfig.gate.command)}"`)
  ) {
    passed += 1;
  } else {
    console.error('FAIL gate evidence is derived from the executed config and clean head');
  }
  try {
    gateSummary(
      gateConfig,
      gateSnapshot.checkout.headOid,
      gateSnapshot,
      {
        ...structuredClone(gateSnapshot),
        checkout: { ...gateSnapshot.checkout, clean: false },
      },
      { status: 0, signal: null, error: null },
    );
    console.error('FAIL gate evidence rejects a changed or dirty checkout');
  } catch {
    passed += 1;
  }
  const total = cases.length + 19;
  console.log(passed === total ? `self-test OK (${passed} cases)` : `self-test FAILED (${passed}/${total})`);
  return passed === total;
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.selfTest) process.exit(selfTest() ? 0 : 1);
  if (parsed.error) {
    console.error(`publish-verdict: ${parsed.error}`);
    process.exit(2);
  }
  let summary;
  let publicationSnapshot;
  try {
    publicationSnapshot = snapshotExecutionRepository(process.cwd());
    if (
      publicationSnapshot.checkout.headOid !== parsed.sha
      || publicationSnapshot.checkout.clean !== true
    ) {
      throw new Error('publication requires the exact clean live checkout at the requested SHA');
    }
    if (parsed.ctx === 'gate') {
      const statePath = resolve(
        publicationSnapshot.checkout.root,
        'docs',
        'agentic',
        'STATE.md',
      );
      const config = extractConfig(
        readBoundedNoFollow(
          statePath,
          MAX_AUXILIARY_EVIDENCE_BYTES,
        ).toString('utf8'),
      );
      const configErrors = validateConfig(config);
      if (configErrors.length > 0) {
        throw new Error(`ProjectConfig is invalid: ${configErrors.join('; ')}`);
      }
      const gateResult = runGate(
        config.gate.command,
        publicationSnapshot.checkout.root,
      );
      const currentSnapshot = snapshotExecutionRepository(
        publicationSnapshot.checkout.root,
      );
      summary = gateSummary(
        config,
        parsed.sha,
        publicationSnapshot,
        currentSnapshot,
        gateResult,
      );
      publicationSnapshot = currentSnapshot;
    } else if (parsed.attestationFile !== null) {
      const attestation = JSON.parse(
        readBoundedNoFollow(
          parsed.attestationFile,
          MAX_AUXILIARY_EVIDENCE_BYTES,
        ).toString('utf8'),
      );
      const errors = validateAttestation(attestation, {
        kind: parsed.ctx,
        headOid: parsed.sha,
      });
      if (errors.length > 0) throw new Error(errors.join('; '));
      summary = serializeAttestation(attestation);
    } else if (parsed.reviewEvidenceFile !== null) {
      const bytes = readBoundedNoFollow(
        parsed.reviewEvidenceFile,
        MAX_REVIEW_EVIDENCE_BYTES,
      );
      const evidence = JSON.parse(bytes.toString('utf8'));
      summary = reviewSummary(
        evidence,
        parsed.sha,
        publicationSnapshot.checkout,
      );
    } else {
      throw new Error('publication evidence mode is missing');
    }
    const currentSnapshot = snapshotExecutionRepository(
      publicationSnapshot.checkout.root,
    );
    if (!samePublicationSnapshot(publicationSnapshot, currentSnapshot)) {
      throw new Error(
        'checkout or publication repository changed after evidence validation',
      );
    }
    publicationSnapshot = currentSnapshot;
  } catch (error) {
    console.error(`publish-verdict: evidence file could not be read or validated: ${error.message}`);
    process.exit(1);
  }
  const payload = buildCheckRun(parsed.ctx, parsed.sha, summary);
  try {
    const output = execFileSync(
      'gh',
      buildGitHubApiArgs(publicationSnapshot.repository),
      {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 15000,
      },
    );
    const checkRun = JSON.parse(output);
    if (
      checkRun.name !== payload.name
      || checkRun.head_sha !== parsed.sha
      || checkRun.status !== 'completed'
      || checkRun.conclusion !== 'success'
    ) {
      throw new Error('GitHub returned a mismatched CheckRun');
    }
    if (
      parsed.expectedAppId !== null
      && !hasTrustedProducer(checkRun, [parsed.expectedAppId])
    ) {
      throw new Error(`CheckRun producer app ${checkRun.app?.id ?? 'unknown'} is not expected app ${parsed.expectedAppId}`);
    }
    console.log(
      `posted ${payload.name}=success on ${parsed.sha.slice(0, 12)} via app ${checkRun.app?.id ?? 'unknown'}`,
    );
  } catch (error) {
    console.error(`publish-verdict: gh api failed: ${error.message}`);
    process.exit(1);
  }
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMain) main();
