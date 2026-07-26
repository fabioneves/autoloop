#!/usr/bin/env node

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validPremergeRecordId } from './attestation-contract.mjs';

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
const TRUSTED_ROLES = new Set(['admin', 'maintain', 'write']);

function validAppIdList(appIds) {
  return (
    Array.isArray(appIds)
    && new Set(appIds).size === appIds.length
    && appIds.every((id) => Number.isSafeInteger(id) && id > 0)
  );
}

function validAppIds(appIds) {
  return validAppIdList(appIds) && appIds.length > 0;
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function requiredCheckMap(checks, reasons, path, allowUnpinned = false) {
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
      || (!allowUnpinned && check.appIds.length === 0)
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

function validateServerPolicy(config, serverPolicy, configuredChecks, currentChecks, reasons) {
  if (serverPolicy?.complete !== true) {
    reasons.push('server policy evidence is incomplete');
    return;
  }
  if (serverPolicy.source !== 'live') reasons.push('server policy was not derived from live GitHub state');
  if (serverPolicy.rulesetsComplete !== true) reasons.push('applicable ruleset evidence is incomplete');
  if (serverPolicy.bypassActorsVisible !== true) reasons.push('ruleset bypass actors are hidden or incomplete');
  if (config.baseFreshnessStrategy !== 'direct-strict') {
    reasons.push('merge queue is disabled until merge_group producers and durable recovery exist');
  }
  if (serverPolicy.strategy !== config.baseFreshnessStrategy) {
    reasons.push('server base-freshness strategy does not match policy');
  }
  if (serverPolicy.strategy !== 'direct-strict') reasons.push('server policy is not direct-strict');
  if (serverPolicy.actorCanBypass !== false) reasons.push('merge actor can bypass server policy');
  if (serverPolicy.enforceAdmins !== true) reasons.push('server policy does not enforce administrators');
  if (serverPolicy.requiredConversationResolution !== true) {
    reasons.push('server policy does not require conversation resolution');
  }
  if (
    !Number.isInteger(serverPolicy.requiredApprovingReviewCount)
    || serverPolicy.requiredApprovingReviewCount < config.requiredApprovingReviewCount
  ) {
    reasons.push('server approving-review count is weaker than configured');
  }
  if (config.requireCodeOwnerReviews === true && serverPolicy.requireCodeOwnerReviews !== true) {
    reasons.push('server policy does not require configured code-owner review');
  }
  if (serverPolicy.dismissStaleReviews !== true) reasons.push('server policy does not dismiss stale reviews');
  if (serverPolicy.requireLastPushApproval !== true) {
    reasons.push('server policy does not require approval after the latest push');
  }
  if (serverPolicy.forcePushesAllowed !== false) reasons.push('server policy allows force pushes');
  if (serverPolicy.deletionsAllowed !== false) reasons.push('server policy allows base deletion');
  if (serverPolicy.queueRequired !== false) reasons.push('server policy requires unsupported merge-queue execution');

  const enforced = requiredCheckMap(serverPolicy.requiredChecks, reasons, 'serverPolicy.requiredChecks');
  for (const [name, appIds] of configuredChecks) {
    const serverAppIds = enforced.get(name);
    if (!serverAppIds || [...serverAppIds].some((id) => !appIds.has(id))) {
      reasons.push(`server policy does not pin required check ${name} to an approved producer`);
      continue;
    }
    const matchingChecks = Array.isArray(currentChecks)
      ? currentChecks.filter((check) => check?.name === name)
      : [];
    if (matchingChecks.length === 1 && !serverAppIds.has(matchingChecks[0]?.app?.id)) {
      reasons.push(`current CheckRun ${name} producer does not match the live server pin`);
    }
  }

  if (serverPolicy.strict !== true) reasons.push('direct merge does not require the branch to be up to date');
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
    // An empty pin set exists only under solo mode, where requiredCheckMap accepted
    // the unpinned contract: name + exact head + success is the whole producer claim.
    if (appIds.size > 0 && !appIds.has(check.app?.id)) {
      reasons.push(`required CheckRun ${name} has an unapproved producer`);
    }
  }
  for (const check of pr.checks) {
    if (check?.headOid !== pr.headRefOid) continue;
    const status = String(check.status ?? '').toUpperCase();
    const conclusion = String(check.conclusion ?? '').toUpperCase();
    if (status !== 'COMPLETED') reasons.push(`triggered CheckRun ${check?.name ?? 'unknown'} is not completed`);
    else if (!new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']).has(conclusion)) {
      reasons.push(`triggered CheckRun ${check?.name ?? 'unknown'} is not green`);
    }
    if (
      String(check?.name ?? '').startsWith('agentic/')
      && check.name !== 'agentic/human-authorization'
      && !configuredChecks.has(check.name)
    ) {
      reasons.push(`unconfigured agentic CheckRun present: ${check.name}`);
    }
  }
}

function validateLinkedIssue(config, pr, reasons, solo = false) {
  const issue = pr.linkedIssue;
  if (issue?.complete !== true) reasons.push('linked issue evidence is incomplete');
  if (issue?.state !== 'OPEN') reasons.push('linked issue is not open');
  if (!Array.isArray(issue?.labels)) {
    reasons.push('linked issue labels are incomplete');
  } else {
    for (const label of issue.labels) {
      if (HARD_LABELS.has(label)) reasons.push(`linked issue hard-block label present: ${label}`);
    }
    if (!issue.labels.includes('loop-ready')) reasons.push('linked issue is not currently loop-ready');
    if (!issue.labels.includes('loop-delivered')) reasons.push('linked issue is not delivered');
  }
  if (issue?.blocked !== false) reasons.push('linked issue is blocked or blocker state is unknown');

  const loopReady = issue?.loopReady;
  const editedAt = issue?.lastEditedAt ?? issue?.createdAt;
  if (
    loopReady?.complete !== true
    || !Number.isSafeInteger(loopReady.eventId)
    || loopReady.eventId < 1
    || typeof loopReady.actor !== 'string'
    || loopReady.actor.length === 0
    // Solo mode has one login for human and loop, so actor-vs-loop separation is
    // unprovable; the event, role, and freshness requirements all remain.
    || (!solo && loopReady.actor === config.loopLogin)
    || !TRUSTED_ROLES.has(loopReady.roleName)
    || !validTimestamp(loopReady.labeledAt)
    || !validTimestamp(editedAt)
    || Date.parse(loopReady.labeledAt) <= Date.parse(editedAt)
  ) {
    reasons.push('latest loop-ready event is missing, untrusted, or older than issue content');
  }

  if (issue?.dependenciesComplete !== true || !Array.isArray(issue?.dependencies)) {
    reasons.push('linked issue dependency evidence is incomplete');
  } else {
    const numbers = new Set();
    for (const dependency of issue.dependencies) {
      if (
        !Number.isSafeInteger(dependency?.number)
        || dependency.number < 1
        || numbers.has(dependency.number)
      ) {
        reasons.push('linked issue dependency identity is invalid');
      } else {
        numbers.add(dependency.number);
      }
      if (dependency?.state !== 'CLOSED') {
        reasons.push(`linked issue dependency #${dependency?.number ?? 'unknown'} is not closed`);
      }
    }
  }
  if (issue?.dependenciesClear !== true) {
    reasons.push('linked issue dependencies are unresolved or unknown');
  }
}

function validateOwnership(config, pr, reasons) {
  const ownership = pr.ownership;
  if (ownership?.complete !== true) reasons.push('ownership evidence is incomplete');
  if (
    !HASH_RE.test(ownership?.issueBodyHash ?? '')
    || ownership.issueBodyHash !== pr.linkedIssue?.bodyHash
  ) {
    reasons.push('linked issue body identity is missing or changed');
  }
  if (ownership?.claimCommitAncestor !== true) reasons.push('claim commit ancestry is not proven');
  const claimCommit = ownership?.claimCommit;
  if (
    claimCommit?.complete !== true
    || !Array.isArray(claimCommit.commits)
    || claimCommit.commits.length === 0
  ) {
    reasons.push('claim commit metadata is incomplete');
  } else {
    const malformed = claimCommit.commits.some((commit) =>
      !SHA_RE.test(commit?.oid ?? '')
      || typeof commit?.message !== 'string'
      || !Array.isArray(commit?.parentOids)
      || commit.parentOids.some((oid) => !SHA_RE.test(oid ?? '')));
    if (malformed || new Set(claimCommit.commits.map((commit) => commit?.oid)).size !== claimCommit.commits.length) {
      reasons.push('claim commit metadata is malformed or duplicated');
    }
    if (
      claimCommit.issue !== pr.claim?.issue
      || claimCommit.headOid !== pr.headRefOid
      || claimCommit.baseOid !== pr.baseRefOid
    ) {
      reasons.push('claim commit metadata is not bound to the PR issue, head, and base');
    }
    const first = claimCommit.commits[0];
    const last = claimCommit.commits.at(-1);
    if (claimCommit.oid !== first?.oid) reasons.push('attested claim commit does not start the PR');
    if (first?.message !== `chore: claim #${pr.claim?.issue}`) {
      reasons.push('branch-starting claim commit message is not canonical');
    }
    if (
      first?.parentOids?.length !== 1
      || first.parentOids[0] !== pr.baseRefOid
      || claimCommit.baseOid !== pr.baseRefOid
    ) {
      reasons.push('branch-starting claim commit is not parented by the current base');
    }
    if (last?.oid !== pr.headRefOid) reasons.push('claim commit metadata does not reach the current PR head');
  }
  if (
    ownership?.frozenPlanPresent !== true
    || ownership?.frozenPlanCommentVerified !== true
    || !HASH_RE.test(ownership?.frozenPlanHash ?? '')
    || typeof ownership?.frozenPlanCommentId !== 'string'
    || ownership.frozenPlanCommentId.length === 0
    || ownership?.frozenPlanAuthor !== config.loopLogin
  ) {
    reasons.push('frozen-plan comment identity, author, or content is unverified');
  }
}

function validateAuthorization(config, pr, reasons, solo = false) {
  if (pr.path !== 'A') return;
  const authorization = pr.authorization;
  if (authorization?.complete !== true) {
    reasons.push('Path A human authorization evidence is incomplete');
    return;
  }
  if (
    !Array.isArray(config.trustedHumanLogins)
    || !config.trustedHumanLogins.includes(authorization.actor)
    || (!solo && authorization.actor === config.loopLogin)
  ) {
    reasons.push('Path A authorization is not attributable to a trusted human');
  }
  if (!SAFE_LABELS.has(authorization.label) || !pr.labels.includes(authorization.label)) {
    reasons.push('Path A authorization label is missing or invalid');
  }
  if (authorization.pullRequest !== pr.number) {
    reasons.push('Path A authorization is not bound to this pull request');
  }
  if (authorization.headOid !== pr.headRefOid) reasons.push('Path A authorization is not bound to the current head');
  if (
    authorization.eventVerified !== true
    || authorization.afterCurrentHead !== true
    || !Number.isSafeInteger(authorization.labelEventId)
    || authorization.labelEventId < 1
    || !validTimestamp(authorization.labeledAt)
    || !TRUSTED_ROLES.has(authorization.roleName)
  ) {
    reasons.push(
      'Path A authorization label event, current-head ordering, or current actor permission is unverified',
    );
  }
  // Without a GitHub App there is no one to publish the dedicated authorization
  // CheckRun; solo mode keeps the label-event, head-binding, and ordering proofs
  // above as the whole Path-A evidence.
  if (solo) return;
  const attestationIds = new Set(config.authorizationAppIds ?? []);
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
  const solo = config.soloOperator === true;
  // Solo mode is single-identity by definition: the one human IS the loop login.
  // Naming anyone else means identity separation was available after all, so the
  // relaxation would be unjustified — fail closed on that misconfiguration.
  const identityValid = Array.isArray(config.trustedHumanLogins)
    && config.trustedHumanLogins.length > 0
    && config.trustedHumanLogins.every((login) => typeof login === 'string' && login.length > 0)
    && (solo
      ? config.trustedHumanLogins.length === 1
        && config.trustedHumanLogins[0] === config.loopLogin
      : !config.trustedHumanLogins.includes(config.loopLogin));
  const appIdsValid = solo
    ? validAppIdList(config.automationAppIds) && validAppIdList(config.authorizationAppIds)
    : validAppIds(config.automationAppIds) && validAppIds(config.authorizationAppIds);
  const reviewCountValid = Number.isInteger(config.requiredApprovingReviewCount)
    && config.requiredApprovingReviewCount >= (solo ? 0 : 1);
  if (
    typeof config.repository?.owner !== 'string'
    || typeof config.repository?.name !== 'string'
    || typeof config.baseBranch !== 'string'
    || !new Set(['ratified', 'auto']).has(config.mergePolicy)
    || config.baseFreshnessStrategy !== 'direct-strict'
    || typeof config.loopLogin !== 'string'
    || config.loopLogin.length === 0
    || (config.soloOperator !== undefined && typeof config.soloOperator !== 'boolean')
    || !identityValid
    || !appIdsValid
    || !reviewCountValid
    || typeof config.requireCodeOwnerReviews !== 'boolean'
  ) {
    reasons.push('merge authorization config is invalid');
  }
  const automationAppIds = new Set(config.automationAppIds ?? []);
  const authorizationAppIds = new Set(config.authorizationAppIds ?? []);
  if ([...automationAppIds].some((id) => authorizationAppIds.has(id))) {
    reasons.push('automation and human-authorization App IDs overlap');
  }
  const configuredChecks = requiredCheckMap(config.requiredChecks, reasons, 'config.requiredChecks', solo);
  for (const name of REQUIRED_ATTESTATIONS) {
    const appIds = configuredChecks.get(name);
    if (!appIds) reasons.push(`config is missing required attestation ${name}`);
    else if ([...appIds].some((id) => !automationAppIds.has(id))) {
      reasons.push(`required attestation ${name} is not restricted to automation producers`);
    }
  }

  if (pr.complete !== true) reasons.push('PR evidence is incomplete');
  if (pr.state !== 'OPEN') reasons.push('PR is not open');
  if (pr.isDraft !== false) reasons.push('PR is still draft or draft state is unknown');
  if (pr.baseRefName !== config.baseBranch) reasons.push('PR base does not match the configured base');
  if (!SHA_RE.test(pr.baseRefOid ?? '')) reasons.push('PR base OID is invalid');
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
  }
  // GitHub forbids approving one's own PR, so a solo repository can never reach
  // APPROVED; an explicit request for changes still blocks in every mode.
  if (solo) {
    if (pr.reviewDecision === 'CHANGES_REQUESTED') {
      reasons.push('current review decision requests changes');
    }
  } else if (pr.reviewDecision !== 'APPROVED') {
    reasons.push('current review decision is not approved');
  }
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
  validateLinkedIssue(config, pr, reasons, solo);
  validateOwnership(config, pr, reasons);

  if (pr.lifecycle?.complete !== true) reasons.push('lifecycle evidence is incomplete');
  if (pr.lifecycle?.delivered !== true) reasons.push('lifecycle is not delivered');
  if (pr.lifecycle?.headOid !== pr.headRefOid) reasons.push('lifecycle evidence is not bound to the current head');
  if (
    pr.lifecycle?.premergeRecord !== true
    || !validPremergeRecordId(pr.lifecycle?.premergeRecordId)
    || !HASH_RE.test(pr.lifecycle?.premergeRecordHash ?? '')
    || pr.lifecycle?.premergeRecordAuthor !== config.loopLogin
    || typeof pr.lifecycle?.premergeRecordCommentId !== 'string'
    || pr.lifecycle.premergeRecordCommentId.length === 0
    || pr.lifecycle?.premergeRecordIssue !== pr.claim?.issue
    || pr.lifecycle?.premergeRecordPullRequest !== pr.number
  ) {
    reasons.push('pre-merge audit record identity, author, or content is unverified');
  }
  if (pr.gateEvidenceVerified !== true) {
    reasons.push('typed exact-head gate evidence is missing or invalid');
  }
  if (pr.conversationsResolved !== true) reasons.push('review conversations are unresolved or unknown');
  if (pr.killSwitch?.complete !== true) reasons.push('kill-switch evidence is incomplete');
  if (pr.killSwitch?.active !== false) reasons.push('automerge kill switch is active or unknown');

  if (!new Set(['A', 'B', 'all-green']).has(pr.path)) reasons.push('merge path is missing or invalid');
  if (config.mergePolicy === 'ratified' && !new Set(['A', 'B']).has(pr.path)) {
    reasons.push('ratified policy does not authorize the all-green path');
  }
  validateAuthorization(config, pr, reasons, solo);
  validateChecks(pr, configuredChecks, reasons);
  if (
    input.executorIdentity?.complete !== true
    || input.executorIdentity?.login !== config.loopLogin
    || !Number.isSafeInteger(input.executorIdentity?.id)
    || input.executorIdentity.id < 1
  ) {
    reasons.push('merge executor identity is incomplete or does not match the dedicated loop login');
  }
  // A plan without branch protection has no live server policy to verify; solo
  // mode substitutes exact-head CAS semantics plus the CLEAN merge-state gate in
  // the executor, both of which remain unconditional.
  if (!solo) validateServerPolicy(config, input.serverPolicy, configuredChecks, pr.checks, reasons);
  return { allow: reasons.length === 0, reasons };
}

const HEAD = 'a'.repeat(40);
const BASE = 'e'.repeat(40);
const CLAIM = 'd'.repeat(40);

function fixture(overrides = {}) {
  const config = {
    repository: { owner: 'owner', name: 'repo' },
    baseBranch: 'main',
    mergePolicy: 'ratified',
    baseFreshnessStrategy: 'direct-strict',
    loopLogin: 'autoloop[bot]',
    trustedHumanLogins: ['maintainer'],
    automationAppIds: [41],
    authorizationAppIds: [42],
    requiredApprovingReviewCount: 1,
    requireCodeOwnerReviews: false,
    requiredChecks: [
      ...REQUIRED_ATTESTATIONS.map((name) => ({ name, appIds: [41] })),
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
      number: 12,
      complete: true,
      state: 'OPEN',
      isDraft: false,
      baseRefName: 'main',
      baseRefOid: BASE,
      headRefName: 'feat/gh-7-safe-change',
      headRefOid: HEAD,
      headRepository: { owner: 'owner', name: 'repo' },
      labels: ['risk:pure-deletion'],
      reviewDecision: 'APPROVED',
      reviewRequests: [],
      claim: { ok: true, issue: 7, branchIssue: 7, bodyIssue: 7 },
      linkedIssue: {
        complete: true,
        number: 7,
        state: 'OPEN',
        labels: ['loop-ready', 'loop-delivered'],
        bodyHash: 'b'.repeat(64),
        createdAt: '2026-07-24T00:00:00Z',
        lastEditedAt: '2026-07-24T00:01:00Z',
        blocked: false,
        dependenciesClear: true,
        loopReady: {
          complete: true,
          eventId: 7001,
          actor: 'maintainer',
          labeledAt: '2026-07-24T00:02:00Z',
          roleName: 'maintain',
        },
        dependenciesComplete: true,
        dependencies: [{ number: 6, state: 'CLOSED' }],
      },
      ownership: {
        complete: true,
        issueBodyHash: 'b'.repeat(64),
        claimCommitAncestor: true,
        claimCommit: {
          complete: true,
          issue: 7,
          headOid: HEAD,
          baseOid: BASE,
          oid: CLAIM,
          commits: [
            {
              oid: CLAIM,
              message: 'chore: claim #7',
              parentOids: [BASE],
            },
            {
              oid: HEAD,
              message: 'feat: implement safe change',
              parentOids: [CLAIM],
            },
          ],
        },
        frozenPlanPresent: true,
        frozenPlanHash: 'c'.repeat(64),
        frozenPlanCommentId: 'IC_kwDOAutoloop7',
        frozenPlanAuthor: 'autoloop[bot]',
        frozenPlanCommentVerified: true,
      },
      lifecycle: {
        complete: true,
        delivered: true,
        headOid: HEAD,
        premergeRecord: true,
        premergeRecordId: `pmr_${'d'.repeat(64)}`,
        premergeRecordHash: 'e'.repeat(64),
        premergeRecordAuthor: 'autoloop[bot]',
        premergeRecordCommentId: 'IC_premerge',
        premergeRecordIssue: 7,
        premergeRecordPullRequest: 12,
      },
      gateEvidenceVerified: true,
      path: 'A',
      authorization: {
        complete: true,
        pullRequest: 12,
        actor: 'maintainer',
        headOid: HEAD,
        label: 'risk:pure-deletion',
        labelEventId: 12001,
        labeledAt: '2026-07-24T00:03:00Z',
        eventVerified: true,
        afterCurrentHead: true,
        roleName: 'maintain',
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
    executorIdentity: {
      complete: true,
      login: 'autoloop[bot]',
      id: 9001,
    },
    serverPolicy: {
      complete: true,
      source: 'live',
      strategy: 'direct-strict',
      strict: true,
      enforceAdmins: true,
      actorCanBypass: false,
      requiredConversationResolution: true,
      requiredApprovingReviewCount: 1,
      requireCodeOwnerReviews: false,
      dismissStaleReviews: true,
      requireLastPushApproval: true,
      forcePushesAllowed: false,
      deletionsAllowed: false,
      queueRequired: false,
      rulesetsComplete: true,
      bypassActorsVisible: true,
      requiredChecks: config.requiredChecks,
    },
    ...overrides,
  };
}

// A solo-operator installation has exactly one human, who necessarily shares the
// loop's login. Identity separation, App attestation, live server policy, and
// approving review are unsatisfiable there, not merely unconfigured; every other
// control keeps its full strength. The fixture models that shape generically.
function soloFixture(overrides = {}) {
  const base = fixture();
  const config = {
    ...base.config,
    soloOperator: true,
    mergePolicy: 'auto',
    loopLogin: 'solo-dev',
    trustedHumanLogins: ['solo-dev'],
    automationAppIds: [],
    authorizationAppIds: [],
    requiredApprovingReviewCount: 0,
    requiredChecks: base.config.requiredChecks.map(({ name }) => ({ name, appIds: [] })),
  };
  const pr = {
    ...base.pr,
    labels: [],
    reviewDecision: null,
    path: 'all-green',
    authorization: undefined,
    linkedIssue: {
      ...base.pr.linkedIssue,
      loopReady: { ...base.pr.linkedIssue.loopReady, actor: 'solo-dev' },
    },
    ownership: { ...base.pr.ownership, frozenPlanAuthor: 'solo-dev' },
    lifecycle: { ...base.pr.lifecycle, premergeRecordAuthor: 'solo-dev' },
    checks: base.pr.checks.map((check) => ({ ...check, app: { id: 15368 } })),
  };
  const merged = {
    config,
    pr,
    executorIdentity: { complete: true, login: 'solo-dev', id: 9001 },
    serverPolicy: undefined,
    ...overrides,
  };
  return merged;
}

function selfTest() {
  const base = fixture();
  const solo = soloFixture();
  const soloPathA = soloFixture();
  soloPathA.config = { ...soloPathA.config, mergePolicy: 'ratified' };
  soloPathA.pr = {
    ...soloPathA.pr,
    labels: ['risk:pure-deletion'],
    path: 'A',
    authorization: {
      ...base.pr.authorization,
      actor: 'solo-dev',
      check: undefined,
    },
  };
  const cases = [
    ['complete strict evidence authorizes', base, true],
    ['delivered state is sourced from the linked issue and lifecycle', fixture({
      pr: { ...base.pr, labels: ['risk:pure-deletion'] },
    }), true],
    ['branch/body issue mismatch blocks', fixture({ pr: { ...base.pr, claim: { ok: false, code: 'ISSUE_MISMATCH' } } }), false],
    ['claim commit later in the PR blocks', fixture({
      pr: {
        ...base.pr,
        ownership: {
          ...base.pr.ownership,
          claimCommit: {
            ...base.pr.ownership.claimCommit,
            commits: [...base.pr.ownership.claimCommit.commits].reverse(),
          },
        },
      },
    }), false],
    ['claim commit with a non-canonical message blocks', fixture({
      pr: {
        ...base.pr,
        ownership: {
          ...base.pr.ownership,
          claimCommit: {
            ...base.pr.ownership.claimCommit,
            commits: base.pr.ownership.claimCommit.commits.map((commit, index) =>
              index === 0 ? { ...commit, message: 'chore: claim issue 7' } : commit),
          },
        },
      },
    }), false],
    ['claim commit not parented by the current base blocks', fixture({
      pr: {
        ...base.pr,
        ownership: {
          ...base.pr.ownership,
          claimCommit: {
            ...base.pr.ownership.claimCommit,
            commits: base.pr.ownership.claimCommit.commits.map((commit, index) =>
              index === 0 ? { ...commit, parentOids: ['f'.repeat(40)] } : commit),
          },
        },
      },
    }), false],
    ['claim commit metadata for a stale head blocks', fixture({
      pr: {
        ...base.pr,
        ownership: {
          ...base.pr.ownership,
          claimCommit: {
            ...base.pr.ownership.claimCommit,
            headOid: 'f'.repeat(40),
          },
        },
      },
    }), false],
    ['missing typed gate evidence blocks', fixture({
      pr: { ...base.pr, gateEvidenceVerified: false },
    }), false],
    ['missing frozen plan blocks', fixture({ pr: { ...base.pr, ownership: { ...base.pr.ownership, frozenPlanPresent: false } } }), false],
    ['unverified frozen-plan comment blocks', fixture({ pr: { ...base.pr, ownership: { ...base.pr.ownership, frozenPlanCommentVerified: false } } }), false],
    ['undelivered lifecycle blocks', fixture({ pr: { ...base.pr, lifecycle: { ...base.pr.lifecycle, delivered: false } } }), false],
    ['caller premerge record string never authorizes', fixture({
      pr: {
        ...base.pr,
        lifecycle: {
          ...base.pr.lifecycle,
          premergeRecord: 'does-not-exist',
        },
      },
    }), false],
    ['bare premerge boolean without hydrated identity blocks', fixture({
      pr: {
        ...base.pr,
        lifecycle: {
          complete: true,
          delivered: true,
          headOid: HEAD,
          premergeRecord: true,
        },
      },
    }), false],
    ['premerge record from a non-loop author blocks', fixture({
      pr: {
        ...base.pr,
        lifecycle: {
          ...base.pr.lifecycle,
          premergeRecordAuthor: 'maintainer',
        },
      },
    }), false],
    ['blocked issue blocks', fixture({ pr: { ...base.pr, linkedIssue: { ...base.pr.linkedIssue, blocked: true } } }), false],
    ['current linked-issue hard label blocks stale clear booleans', fixture({
      pr: {
        ...base.pr,
        linkedIssue: {
          ...base.pr.linkedIssue,
          labels: [...base.pr.linkedIssue.labels, 'needs-dependency'],
        },
      },
    }), false],
    ['issue edit after loop-ready approval blocks', fixture({
      pr: {
        ...base.pr,
        linkedIssue: {
          ...base.pr.linkedIssue,
          lastEditedAt: '2026-07-24T00:04:00Z',
        },
      },
    }), false],
    ['write-role loop-ready actor remains trusted', fixture({
      pr: {
        ...base.pr,
        linkedIssue: {
          ...base.pr.linkedIssue,
          loopReady: { ...base.pr.linkedIssue.loopReady, roleName: 'write' },
        },
      },
    }), true],
    ['read-role loop-ready actor blocks', fixture({
      pr: {
        ...base.pr,
        linkedIssue: {
          ...base.pr.linkedIssue,
          loopReady: { ...base.pr.linkedIssue.loopReady, roleName: 'read' },
        },
      },
    }), false],
    ['reopened dependency blocks stale clear boolean', fixture({
      pr: {
        ...base.pr,
        linkedIssue: {
          ...base.pr.linkedIssue,
          dependencies: [{ number: 6, state: 'OPEN' }],
        },
      },
    }), false],
    ['changes requested blocks', fixture({ pr: { ...base.pr, reviewDecision: 'CHANGES_REQUESTED' } }), false],
    ['pending reviewer blocks', fixture({ pr: { ...base.pr, reviewRequests: ['maintainer'] } }), false],
    ['untrusted verdict producer blocks', fixture({ pr: { ...base.pr, checks: base.pr.checks.map((check, index) => index === 0 ? { ...check, app: { id: 99 } } : check) } }), false],
    ['stale verdict head blocks', fixture({ pr: { ...base.pr, checks: base.pr.checks.map((check, index) => index === 0 ? { ...check, headOid: 'd'.repeat(40) } : check) } }), false],
    ['pending triggered check blocks', fixture({ pr: { ...base.pr, checks: [...base.pr.checks, { name: 'optional-ci', headOid: HEAD, status: 'IN_PROGRESS', conclusion: null, app: { id: 7 } }] } }), false],
    ['stale failing check does not gate current head', fixture({ pr: { ...base.pr, checks: [...base.pr.checks, { name: 'old-ci', headOid: 'd'.repeat(40), status: 'COMPLETED', conclusion: 'FAILURE', app: { id: 7 } }] } }), true],
    ['unconfigured agentic check blocks', fixture({ pr: { ...base.pr, checks: [...base.pr.checks, { name: 'agentic/unknown', headOid: HEAD, status: 'COMPLETED', conclusion: 'SUCCESS', app: { id: 42 } }] } }), false],
    ['Path A loop-authored approval blocks', fixture({ pr: { ...base.pr, authorization: { ...base.pr.authorization, actor: 'autoloop[bot]' } } }), false],
    ['Path A authorization accepts a configured human with write role', fixture({
      pr: {
        ...base.pr,
        authorization: { ...base.pr.authorization, roleName: 'write' },
      },
    }), true],
    ['Path A authorization on old head blocks', fixture({ pr: { ...base.pr, authorization: { ...base.pr.authorization, headOid: 'd'.repeat(40) } } }), false],
    ['Path A authorization label older than the current head blocks', fixture({
      pr: {
        ...base.pr,
        authorization: { ...base.pr.authorization, afterCurrentHead: false },
      },
    }), false],
    ['Path A authorization from an untrusted app blocks', fixture({ pr: { ...base.pr, authorization: { ...base.pr.authorization, check: { ...base.pr.authorization.check, app: { id: 99 } } } } }), false],
    ['Path A authorization without a verified current label event blocks', fixture({
      pr: {
        ...base.pr,
        authorization: { ...base.pr.authorization, eventVerified: false },
      },
    }), false],
    ['overlapping automation and authorization producers block', fixture({
      config: {
        ...base.config,
        automationAppIds: [42],
      },
    }), false],
    ['Path B needs no human authorization', fixture({ pr: { ...base.pr, path: 'B', authorization: null } }), true],
    ['all-green path requires auto policy', fixture({ config: { ...base.config, mergePolicy: 'auto' }, pr: { ...base.pr, path: 'all-green', authorization: null } }), true],
    ['executor identity mismatch blocks', fixture({
      executorIdentity: { complete: true, login: 'maintainer', id: 2 },
    }), false],
    ['non-strict direct protection blocks', fixture({ serverPolicy: { ...base.serverPolicy, strict: false } }), false],
    ['server bypass blocks', fixture({ serverPolicy: { ...base.serverPolicy, actorCanBypass: true } }), false],
    ['caller-authored server-policy source blocks', fixture({
      serverPolicy: { ...base.serverPolicy, source: 'attestation' },
    }), false],
    ['incomplete ruleset enumeration blocks', fixture({
      serverPolicy: { ...base.serverPolicy, rulesetsComplete: false },
    }), false],
    ['hidden ruleset bypass actors block', fixture({
      serverPolicy: { ...base.serverPolicy, bypassActorsVisible: false },
    }), false],
    ['server check with an alternate unapproved producer blocks', fixture({
      serverPolicy: {
        ...base.serverPolicy,
        requiredChecks: base.serverPolicy.requiredChecks.map((check) =>
          check.name === 'agentic/gate'
            ? { ...check, appIds: [...check.appIds, 42] }
            : check),
      },
    }), false],
    ['current check producer must match the live server pin', fixture({
      config: {
        ...base.config,
        automationAppIds: [41, 43],
        requiredChecks: base.config.requiredChecks.map((check) =>
          check.name === 'agentic/gate'
            ? { ...check, appIds: [41, 43] }
            : check),
      },
      pr: {
        ...base.pr,
        checks: base.pr.checks.map((check) =>
          check.name === 'agentic/gate'
            ? { ...check, app: { id: 43 } }
            : check),
      },
    }), false],
    ['review policy weaker than configured intent blocks', fixture({
      config: { ...base.config, requiredApprovingReviewCount: 2 },
    }), false],
    ['missing configured code-owner review blocks', fixture({
      config: { ...base.config, requireCodeOwnerReviews: true },
    }), false],
    [
      'merge queue is disabled until group producers and durable recovery exist',
      fixture({
        config: { ...base.config, baseFreshnessStrategy: 'merge-queue' },
        serverPolicy: {
          ...base.serverPolicy,
          strategy: 'merge-queue',
          strict: false,
          queueRequired: true,
        },
      }),
      false,
    ],
    ['active kill switch blocks', fixture({ pr: { ...base.pr, killSwitch: { complete: true, active: true } } }), false],
    ['incomplete evidence blocks', fixture({ pr: { ...base.pr, checksComplete: false } }), false],

    ['solo operator with single identity and green exact-head evidence authorizes', solo, true],
    ['solo Path-A self-authorization without an App CheckRun authorizes', soloPathA, true],
    ['solo flag absent keeps identity separation required', soloFixture({
      config: (() => { const { soloOperator, ...rest } = soloFixture().config; return rest; })(),
    }), false],
    ['solo with a second trusted human is invalid', soloFixture({
      config: { ...solo.config, trustedHumanLogins: ['solo-dev', 'friend'] },
    }), false],
    ['solo trusted list naming someone other than the loop is invalid', soloFixture({
      config: { ...solo.config, trustedHumanLogins: ['friend'] },
    }), false],
    ['solo pending required check blocks', soloFixture({
      pr: {
        ...solo.pr,
        checks: solo.pr.checks.map((check) =>
          check.name === 'ci' ? { ...check, status: 'IN_PROGRESS', conclusion: null } : check),
      },
    }), false],
    ['solo failing required check blocks', soloFixture({
      pr: {
        ...solo.pr,
        checks: solo.pr.checks.map((check) =>
          check.name === 'ci' ? { ...check, conclusion: 'FAILURE' } : check),
      },
    }), false],
    ['solo hard-block label blocks', soloFixture({
      pr: { ...solo.pr, labels: ['do-not-merge'] },
    }), false],
    ['solo active kill switch blocks', soloFixture({
      pr: { ...solo.pr, killSwitch: { complete: true, active: true } },
    }), false],
    ['solo claim mismatch blocks', soloFixture({
      pr: { ...solo.pr, claim: { ok: false, code: 'ISSUE_MISMATCH' } },
    }), false],
    ['solo changes-requested review still blocks', soloFixture({
      pr: { ...solo.pr, reviewDecision: 'CHANGES_REQUESTED' },
    }), false],
    ['solo pending review request still blocks', soloFixture({
      pr: { ...solo.pr, reviewRequests: ['solo-dev'] },
    }), false],
    ['solo unresolved conversations still block', soloFixture({
      pr: { ...solo.pr, conversationsResolved: false },
    }), false],
    ['solo executor other than the loop login blocks', soloFixture({
      executorIdentity: { complete: true, login: 'someone-else', id: 9002 },
    }), false],
    ['solo stale loop-ready label event still blocks', soloFixture({
      pr: {
        ...solo.pr,
        linkedIssue: {
          ...solo.pr.linkedIssue,
          loopReady: { ...solo.pr.linkedIssue.loopReady, labeledAt: '2026-07-24T00:00:30Z' },
        },
      },
    }), false],
    ['solo Path-A authorization not bound to the current head still blocks', (() => {
      const input = soloFixture();
      input.config = { ...input.config, mergePolicy: 'ratified' };
      input.pr = {
        ...input.pr,
        labels: ['risk:pure-deletion'],
        path: 'A',
        authorization: { ...soloPathA.pr.authorization, headOid: BASE, afterCurrentHead: false },
      };
      return input;
    })(), false],
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
