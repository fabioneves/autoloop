#!/usr/bin/env node

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const REQUIRED_ATTESTATIONS = [
  'agentic/gate',
  'agentic/review',
  'agentic/ownership',
  'agentic/policy',
];

const SHA_RE = /^[0-9a-f]{40}$/i;
const HASH_RE = /^[0-9a-f]{64}$/i;
const SAFE_LABELS = new Set(['risk:pure-deletion', 'risk:mechanical-refactor']);
const HARD_LABELS = new Set([
  'human:authorize',
  'human:legal',
  'automerge:halt',
  'do-not-merge',
  'loop-blocked',
  'needs-human',
  'needs-dependency',
  'needs-secret',
]);

function producerIds(requiredChecks, names) {
  return new Set(
    requiredChecks
      .filter((check) => names.has(check?.name))
      .flatMap((check) => Array.isArray(check.appIds) ? check.appIds : []),
  );
}

function requiredCheckMap(checks, reasons, path) {
  const map = new Map();
  if (!Array.isArray(checks)) {
    reasons.push(`${path} is missing or invalid`);
    return map;
  }
  for (const check of checks) {
    if (
      typeof check?.name !== 'string'
      || check.name.length === 0
      || !Array.isArray(check.appIds)
      || check.appIds.length === 0
      || check.appIds.some((id) => !Number.isInteger(id) || id < 1)
    ) {
      reasons.push(`${path} contains an invalid check contract`);
      continue;
    }
    if (map.has(check.name)) reasons.push(`${path} contains duplicate context ${check.name}`);
    map.set(check.name, new Set(check.appIds));
  }
  return map;
}

function validateServerPolicy(config, serverPolicy, configuredChecks, reasons) {
  if (serverPolicy?.complete !== true) {
    reasons.push('server policy evidence is incomplete');
    return;
  }
  if (serverPolicy.strategy !== config.baseFreshnessStrategy) {
    reasons.push('server base-freshness strategy does not match policy');
  }
  if (serverPolicy.actorCanBypass !== false) reasons.push('merge actor can bypass server policy');
  if (serverPolicy.enforceAdmins !== true) reasons.push('server policy does not enforce administrators');
  if (serverPolicy.requiredConversationResolution !== true) {
    reasons.push('server policy does not require conversation resolution');
  }
  if (!Number.isInteger(serverPolicy.requiredApprovingReviewCount) || serverPolicy.requiredApprovingReviewCount < 1) {
    reasons.push('server policy does not require an approving review');
  }
  if (serverPolicy.dismissStaleReviews !== true) reasons.push('server policy does not dismiss stale reviews');
  if (serverPolicy.requireLastPushApproval !== true) {
    reasons.push('server policy does not require approval after the latest push');
  }
  if (serverPolicy.forcePushesAllowed !== false) reasons.push('server policy allows force pushes');
  if (serverPolicy.deletionsAllowed !== false) reasons.push('server policy allows base deletion');

  const enforced = requiredCheckMap(serverPolicy.requiredChecks, reasons, 'serverPolicy.requiredChecks');
  for (const [name, appIds] of configuredChecks) {
    const serverAppIds = enforced.get(name);
    if (!serverAppIds || ![...serverAppIds].some((id) => appIds.has(id))) {
      reasons.push(`server policy does not pin required check ${name} to an approved producer`);
    }
  }

  if (config.baseFreshnessStrategy === 'direct-strict') {
    if (serverPolicy.strict !== true) reasons.push('direct merge does not require the branch to be up to date');
    return;
  }
  if (config.baseFreshnessStrategy !== 'merge-queue') {
    reasons.push(`unsupported base-freshness strategy ${config.baseFreshnessStrategy ?? 'unknown'}`);
    return;
  }
  if (serverPolicy.queueAvailable !== true) reasons.push('merge queue is unavailable for this repository');
  if (serverPolicy.queueRequired !== true) reasons.push('server policy does not require the merge queue');
  if (serverPolicy.mergeGroupCi !== true) reasons.push('merge_group CI is not configured');
  if (serverPolicy.asyncOutcomeRecovery !== true) reasons.push('merge queue outcome recovery is unavailable');
}

function validateChecks(pr, configuredChecks, reasons) {
  if (pr.checksComplete !== true || !Array.isArray(pr.checks)) {
    reasons.push('check evidence is incomplete');
    return;
  }
  for (const [name, appIds] of configuredChecks) {
    const matching = pr.checks.filter((check) => check?.name === name);
    if (matching.length !== 1) {
      reasons.push(`required CheckRun ${name} count is ${matching.length}, expected 1`);
      continue;
    }
    const check = matching[0];
    if (check.headOid !== pr.headRefOid) reasons.push(`required CheckRun ${name} is not on the current head`);
    if (String(check.status ?? '').toUpperCase() !== 'COMPLETED') {
      reasons.push(`required CheckRun ${name} is not completed`);
    }
    if (String(check.conclusion ?? '').toUpperCase() !== 'SUCCESS') {
      reasons.push(`required CheckRun ${name} is not successful`);
    }
    if (!appIds.has(check.app?.id)) reasons.push(`required CheckRun ${name} has an unapproved producer`);
  }
  for (const check of pr.checks) {
    if (check?.headOid !== pr.headRefOid) continue;
    const status = String(check.status ?? '').toUpperCase();
    const conclusion = String(check.conclusion ?? '').toUpperCase();
    if (status !== 'COMPLETED') reasons.push(`triggered CheckRun ${check?.name ?? 'unknown'} is not completed`);
    else if (!new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']).has(conclusion)) {
      reasons.push(`triggered CheckRun ${check?.name ?? 'unknown'} is not green`);
    }
    if (String(check?.name ?? '').startsWith('agentic/') && !configuredChecks.has(check.name)) {
      reasons.push(`unconfigured agentic CheckRun present: ${check.name}`);
    }
  }
}

function validateAuthorization(config, pr, reasons) {
  if (pr.path !== 'A') return;
  const authorization = pr.authorization;
  if (authorization?.complete !== true) {
    reasons.push('Path A human authorization evidence is incomplete');
    return;
  }
  if (
    !Array.isArray(config.trustedHumanLogins)
    || !config.trustedHumanLogins.includes(authorization.actor)
    || authorization.actor === config.loopLogin
  ) {
    reasons.push('Path A authorization is not attributable to a trusted human');
  }
  if (!SAFE_LABELS.has(authorization.label) || !pr.labels.includes(authorization.label)) {
    reasons.push('Path A authorization label is missing or invalid');
  }
  if (authorization.headOid !== pr.headRefOid) reasons.push('Path A authorization is not bound to the current head');
  const attestationIds = producerIds(
    config.requiredChecks,
    new Set(REQUIRED_ATTESTATIONS),
  );
  const check = authorization.check;
  if (
    check?.name !== 'agentic/human-authorization'
    || check.headOid !== pr.headRefOid
    || String(check.status ?? '').toUpperCase() !== 'COMPLETED'
    || String(check.conclusion ?? '').toUpperCase() !== 'SUCCESS'
    || !attestationIds.has(check.app?.id)
  ) {
    reasons.push('Path A authorization CheckRun is missing, stale, unsuccessful, or untrusted');
  }
}

export function authorizeMerge(input) {
  const reasons = [];
  const config = input?.config;
  const pr = input?.pr;
  if (!config || !pr) return { allow: false, reasons: ['merge authorization input is incomplete'] };
  if (
    typeof config.repository?.owner !== 'string'
    || typeof config.repository?.name !== 'string'
    || typeof config.baseBranch !== 'string'
    || !new Set(['ratified', 'auto']).has(config.mergePolicy)
    || typeof config.loopLogin !== 'string'
    || config.loopLogin.length === 0
  ) {
    reasons.push('merge authorization config is invalid');
  }
  const configuredChecks = requiredCheckMap(config.requiredChecks, reasons, 'config.requiredChecks');
  for (const name of REQUIRED_ATTESTATIONS) {
    if (!configuredChecks.has(name)) reasons.push(`config is missing required attestation ${name}`);
  }

  if (pr.complete !== true) reasons.push('PR evidence is incomplete');
  if (pr.state !== 'OPEN') reasons.push('PR is not open');
  if (pr.isDraft !== false) reasons.push('PR is still draft or draft state is unknown');
  if (pr.baseRefName !== config.baseBranch) reasons.push('PR base does not match the configured base');
  if (!SHA_RE.test(pr.headRefOid ?? '')) reasons.push('PR head OID is invalid');
  if (
    pr.headRepository?.owner !== config.repository?.owner
    || pr.headRepository?.name !== config.repository?.name
  ) {
    reasons.push('PR head is not in the configured repository');
  }
  if (!Array.isArray(pr.labels)) reasons.push('PR labels are missing');
  else {
    for (const label of pr.labels) {
      if (HARD_LABELS.has(label)) reasons.push(`hard-block label present: ${label}`);
    }
    if (!pr.labels.includes('loop-delivered')) reasons.push('PR is not in delivered lifecycle state');
  }
  if (pr.reviewDecision !== 'APPROVED') reasons.push('current review decision is not approved');
  if (!Array.isArray(pr.reviewRequests)) reasons.push('review-request evidence is missing');
  else if (pr.reviewRequests.length > 0) reasons.push('review requests remain pending');

  if (
    pr.claim?.ok !== true
    || pr.claim.issue !== pr.claim.branchIssue
    || pr.claim.issue !== pr.claim.bodyIssue
    || pr.claim.issue !== pr.linkedIssue?.number
  ) {
    reasons.push('loop ownership claim is invalid or mismatched');
  }
  if (pr.linkedIssue?.complete !== true) reasons.push('linked issue evidence is incomplete');
  if (pr.linkedIssue?.state !== 'OPEN') reasons.push('linked issue is not open');
  if (pr.linkedIssue?.blocked !== false) reasons.push('linked issue is blocked or blocker state is unknown');
  if (pr.linkedIssue?.dependenciesClear !== true) reasons.push('linked issue dependencies are unresolved or unknown');
  if (!Array.isArray(pr.linkedIssue?.labels) || !pr.linkedIssue.labels.includes('loop-delivered')) {
    reasons.push('linked issue is not delivered');
  }

  if (pr.ownership?.complete !== true) reasons.push('ownership evidence is incomplete');
  if (
    !HASH_RE.test(pr.ownership?.issueBodyHash ?? '')
    || pr.ownership.issueBodyHash !== pr.linkedIssue?.bodyHash
  ) {
    reasons.push('linked issue body identity is missing or changed');
  }
  if (pr.ownership?.claimCommitAncestor !== true) reasons.push('claim commit ancestry is not proven');
  if (pr.ownership?.frozenPlanPresent !== true || !HASH_RE.test(pr.ownership?.frozenPlanHash ?? '')) {
    reasons.push('frozen-plan evidence is missing or invalid');
  }

  if (pr.lifecycle?.complete !== true) reasons.push('lifecycle evidence is incomplete');
  if (pr.lifecycle?.delivered !== true) reasons.push('lifecycle is not delivered');
  if (pr.lifecycle?.headOid !== pr.headRefOid) reasons.push('lifecycle evidence is not bound to the current head');
  if (pr.lifecycle?.premergeRecord !== true) reasons.push('pre-merge audit record is missing');
  if (pr.conversationsResolved !== true) reasons.push('review conversations are unresolved or unknown');
  if (pr.killSwitch?.complete !== true) reasons.push('kill-switch evidence is incomplete');
  if (pr.killSwitch?.active !== false) reasons.push('automerge kill switch is active or unknown');

  if (!new Set(['A', 'B', 'all-green']).has(pr.path)) reasons.push('merge path is missing or invalid');
  if (config.mergePolicy === 'ratified' && !new Set(['A', 'B']).has(pr.path)) {
    reasons.push('ratified policy does not authorize the all-green path');
  }
  validateAuthorization(config, pr, reasons);
  validateChecks(pr, configuredChecks, reasons);
  validateServerPolicy(config, input.serverPolicy, configuredChecks, reasons);
  return { allow: reasons.length === 0, reasons };
}

const HEAD = 'a'.repeat(40);

function fixture(overrides = {}) {
  const config = {
    repository: { owner: 'owner', name: 'repo' },
    baseBranch: 'main',
    mergePolicy: 'ratified',
    baseFreshnessStrategy: 'direct-strict',
    loopLogin: 'autoloop[bot]',
    trustedHumanLogins: ['maintainer'],
    requiredChecks: [
      ...REQUIRED_ATTESTATIONS.map((name) => ({ name, appIds: [42] })),
      { name: 'ci', appIds: [7] },
    ],
  };
  const checks = config.requiredChecks.map(({ name, appIds }) => ({
    name,
    headOid: HEAD,
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
    app: { id: appIds[0] },
  }));
  return {
    config,
    pr: {
      complete: true,
      state: 'OPEN',
      isDraft: false,
      baseRefName: 'main',
      headRefName: 'feat/gh-7-safe-change',
      headRefOid: HEAD,
      headRepository: { owner: 'owner', name: 'repo' },
      labels: ['loop-delivered', 'risk:pure-deletion'],
      reviewDecision: 'APPROVED',
      reviewRequests: [],
      claim: { ok: true, issue: 7, branchIssue: 7, bodyIssue: 7 },
      linkedIssue: {
        complete: true,
        number: 7,
        state: 'OPEN',
        labels: ['loop-delivered'],
        bodyHash: 'b'.repeat(64),
        blocked: false,
        dependenciesClear: true,
      },
      ownership: {
        complete: true,
        issueBodyHash: 'b'.repeat(64),
        claimCommitAncestor: true,
        frozenPlanPresent: true,
        frozenPlanHash: 'c'.repeat(64),
      },
      lifecycle: {
        complete: true,
        delivered: true,
        headOid: HEAD,
        premergeRecord: true,
      },
      path: 'A',
      authorization: {
        complete: true,
        actor: 'maintainer',
        headOid: HEAD,
        label: 'risk:pure-deletion',
        check: {
          name: 'agentic/human-authorization',
          headOid: HEAD,
          status: 'COMPLETED',
          conclusion: 'SUCCESS',
          app: { id: 42 },
        },
      },
      checks,
      checksComplete: true,
      conversationsResolved: true,
      killSwitch: { complete: true, active: false },
    },
    serverPolicy: {
      complete: true,
      strategy: 'direct-strict',
      strict: true,
      enforceAdmins: true,
      actorCanBypass: false,
      requiredConversationResolution: true,
      requiredApprovingReviewCount: 1,
      dismissStaleReviews: true,
      requireLastPushApproval: true,
      forcePushesAllowed: false,
      deletionsAllowed: false,
      requiredChecks: config.requiredChecks,
    },
    ...overrides,
  };
}

function selfTest() {
  const base = fixture();
  const cases = [
    ['complete strict evidence authorizes', base, true],
    ['branch/body issue mismatch blocks', fixture({ pr: { ...base.pr, claim: { ok: false, code: 'ISSUE_MISMATCH' } } }), false],
    ['missing frozen plan blocks', fixture({ pr: { ...base.pr, ownership: { ...base.pr.ownership, frozenPlanPresent: false } } }), false],
    ['undelivered lifecycle blocks', fixture({ pr: { ...base.pr, lifecycle: { ...base.pr.lifecycle, delivered: false } } }), false],
    ['blocked issue blocks', fixture({ pr: { ...base.pr, linkedIssue: { ...base.pr.linkedIssue, blocked: true } } }), false],
    ['changes requested blocks', fixture({ pr: { ...base.pr, reviewDecision: 'CHANGES_REQUESTED' } }), false],
    ['pending reviewer blocks', fixture({ pr: { ...base.pr, reviewRequests: ['maintainer'] } }), false],
    ['untrusted verdict producer blocks', fixture({ pr: { ...base.pr, checks: base.pr.checks.map((check, index) => index === 0 ? { ...check, app: { id: 99 } } : check) } }), false],
    ['stale verdict head blocks', fixture({ pr: { ...base.pr, checks: base.pr.checks.map((check, index) => index === 0 ? { ...check, headOid: 'd'.repeat(40) } : check) } }), false],
    ['pending triggered check blocks', fixture({ pr: { ...base.pr, checks: [...base.pr.checks, { name: 'optional-ci', headOid: HEAD, status: 'IN_PROGRESS', conclusion: null, app: { id: 7 } }] } }), false],
    ['stale failing check does not gate current head', fixture({ pr: { ...base.pr, checks: [...base.pr.checks, { name: 'old-ci', headOid: 'd'.repeat(40), status: 'COMPLETED', conclusion: 'FAILURE', app: { id: 7 } }] } }), true],
    ['unconfigured agentic check blocks', fixture({ pr: { ...base.pr, checks: [...base.pr.checks, { name: 'agentic/unknown', headOid: HEAD, status: 'COMPLETED', conclusion: 'SUCCESS', app: { id: 42 } }] } }), false],
    ['Path A loop-authored approval blocks', fixture({ pr: { ...base.pr, authorization: { ...base.pr.authorization, actor: 'autoloop[bot]' } } }), false],
    ['Path A authorization on old head blocks', fixture({ pr: { ...base.pr, authorization: { ...base.pr.authorization, headOid: 'd'.repeat(40) } } }), false],
    ['Path A authorization from an untrusted app blocks', fixture({ pr: { ...base.pr, authorization: { ...base.pr.authorization, check: { ...base.pr.authorization.check, app: { id: 99 } } } } }), false],
    ['Path B needs no human authorization', fixture({ pr: { ...base.pr, path: 'B', authorization: null } }), true],
    ['all-green path requires auto policy', fixture({ config: { ...base.config, mergePolicy: 'auto' }, pr: { ...base.pr, path: 'all-green', authorization: null } }), true],
    ['non-strict direct protection blocks', fixture({ serverPolicy: { ...base.serverPolicy, strict: false } }), false],
    ['server bypass blocks', fixture({ serverPolicy: { ...base.serverPolicy, actorCanBypass: true } }), false],
    [
      'capable merge queue authorizes',
      fixture({
        config: { ...base.config, baseFreshnessStrategy: 'merge-queue' },
        serverPolicy: {
          ...base.serverPolicy,
          strategy: 'merge-queue',
          strict: false,
          queueAvailable: true,
          queueRequired: true,
          mergeGroupCi: true,
          asyncOutcomeRecovery: true,
        },
      }),
      true,
    ],
    [
      'merge queue without merge_group CI blocks',
      fixture({
        config: { ...base.config, baseFreshnessStrategy: 'merge-queue' },
        serverPolicy: {
          ...base.serverPolicy,
          strategy: 'merge-queue',
          strict: false,
          queueAvailable: true,
          queueRequired: true,
          mergeGroupCi: false,
          asyncOutcomeRecovery: true,
        },
      }),
      false,
    ],
    ['active kill switch blocks', fixture({ pr: { ...base.pr, killSwitch: { complete: true, active: true } } }), false],
    ['incomplete evidence blocks', fixture({ pr: { ...base.pr, checksComplete: false } }), false],
  ];
  let passed = 0;
  for (const [name, input, expected] of cases) {
    const result = authorizeMerge(input);
    if (result.allow === expected) passed += 1;
    else console.error(`FAIL ${name}: expected allow=${expected}, got ${result.allow} (${result.reasons.join('; ')})`);
  }
  console.log(passed === cases.length ? `self-test OK (${passed} cases)` : `self-test FAILED (${passed}/${cases.length})`);
  return passed === cases.length;
}

function main() {
  if (process.argv.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const result = authorizeMerge(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.allow ? 0 : 1);
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
