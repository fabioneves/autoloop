#!/usr/bin/env node
// Solo-only merge authorization. The one supported configuration is a single
// PAT-authenticated operator whose login IS the loop login; every non-solo
// mode is a typed refusal (docs/specs/simple-delivery.md). CI protection is
// the triggered-checks floor plus the two SHA-bound verdict statuses — there
// is no required-check list, no App pinning, and no server-policy comparison.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validPremergeRecordId } from './attestation-contract.mjs';

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
const GREEN_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
// The two verdict statuses the finalizer posts (success-only; absence is the
// failure signal). Presence + success is this layer's requirement; the
// byte-exact description-vs-record comparison happens in the premerge-record
// verification path (authorizePolicyPublication), not here.
const REQUIRED_VERDICT_STATUSES = ['agentic/gate', 'agentic/review'];

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

// The triggered-checks floor plus verdict statuses: every check run AND every
// commit status on the exact head must be green — an agentic-named CheckRun,
// if one ever appears, is just another triggered check.
function validateChecks(pr, reasons) {
  if (pr.checksComplete !== true || !Array.isArray(pr.checks)) {
    reasons.push('check evidence is incomplete');
  } else {
    for (const check of pr.checks) {
      if (check?.headOid !== pr.headRefOid) continue;
      const status = String(check.status ?? '').toUpperCase();
      const conclusion = String(check.conclusion ?? '').toUpperCase();
      if (status !== 'COMPLETED') reasons.push(`triggered CheckRun ${check?.name ?? 'unknown'} is not completed`);
      else if (!GREEN_CONCLUSIONS.has(conclusion)) {
        reasons.push(`triggered CheckRun ${check?.name ?? 'unknown'} is not green`);
      }
    }
  }
  const statuses = pr.statuses;
  if (statuses?.complete !== true || !Array.isArray(statuses.items)) {
    reasons.push('commit status evidence is incomplete');
    return;
  }
  const byContext = new Map();
  for (const status of statuses.items) {
    if (
      typeof status?.context !== 'string'
      || status.context.length === 0
      || byContext.has(status.context)
    ) {
      reasons.push('commit status evidence is malformed or ambiguous');
      return;
    }
    byContext.set(status.context, status);
    // Latest state per context: pending blocks, failure/error blocks.
    if (String(status.state ?? '').toLowerCase() !== 'success') {
      reasons.push(`triggered status ${status.context} is not green`);
    }
  }
  for (const context of REQUIRED_VERDICT_STATUSES) {
    const status = byContext.get(context);
    if (!status || String(status.state ?? '').toLowerCase() !== 'success') {
      reasons.push(`verdict status ${context} is missing or not success`);
    }
  }
}

function validateLinkedIssue(config, pr, reasons) {
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
    // Solo mode has one login for human and loop, so the actor may equal the
    // loop login; the event, role, and freshness requirements all remain.
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

// Ownership is derived from live git/PR data — claim ancestry, the frozen
// plan comment, the issue-body identity — not from attestation files.
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

// Path A evidence is the label event itself: verified event, current-head
// ordering, and current actor permission. There is no App to publish a
// dedicated authorization CheckRun, so the label-event proofs are the whole
// Path-A evidence.
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
}

export function authorizeMerge(input) {
  const config = input?.config;
  const pr = input?.pr;
  if (!config || !pr) return { allow: false, reasons: ['merge authorization input is incomplete'] };
  if (config.soloOperator !== true) {
    return {
      allow: false,
      reasons: ['non-solo merge authorization is retired: docs/specs/simple-delivery.md'],
    };
  }
  const reasons = [];
  // Solo mode is single-identity by definition: the one human IS the loop
  // login. Naming anyone else means identity separation was available after
  // all — fail closed on that misconfiguration.
  const identityValid = Array.isArray(config.trustedHumanLogins)
    && config.trustedHumanLogins.length === 1
    && config.trustedHumanLogins[0] === config.loopLogin;
  if (
    typeof config.repository?.owner !== 'string'
    || typeof config.repository?.name !== 'string'
    || typeof config.baseBranch !== 'string'
    || !new Set(['ratified', 'auto']).has(config.mergePolicy)
    || config.baseFreshnessStrategy !== 'direct-strict'
    || typeof config.loopLogin !== 'string'
    || config.loopLogin.length === 0
    || !identityValid
    || !Number.isInteger(config.requiredApprovingReviewCount)
    || config.requiredApprovingReviewCount < 0
    || typeof config.requireCodeOwnerReviews !== 'boolean'
  ) {
    reasons.push('merge authorization config is invalid');
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
  // GitHub forbids approving one's own PR, so a solo repository can never
  // reach APPROVED; an explicit request for changes still blocks.
  if (pr.reviewDecision === 'CHANGES_REQUESTED') {
    reasons.push('current review decision requests changes');
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
  validateLinkedIssue(config, pr, reasons);
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
  validateAuthorization(config, pr, reasons);
  validateChecks(pr, reasons);
  if (
    input.executorIdentity?.complete !== true
    || input.executorIdentity?.login !== config.loopLogin
    || !Number.isSafeInteger(input.executorIdentity?.id)
    || input.executorIdentity.id < 1
  ) {
    reasons.push('merge executor identity is incomplete or does not match the dedicated loop login');
  }
  return { allow: reasons.length === 0, reasons };
}

const HEAD = 'a'.repeat(40);
const BASE = 'e'.repeat(40);
const CLAIM = 'd'.repeat(40);

function verdictStatuses() {
  return [
    {
      context: 'agentic/gate',
      state: 'success',
      description: `autoloop gate verified · sha256:${'1'.repeat(16)}`,
    },
    {
      context: 'agentic/review',
      state: 'success',
      description: `autoloop review verified · sha256:${'2'.repeat(16)}`,
    },
  ];
}

// A solo-operator installation has exactly one human, who necessarily shares
// the loop's login. Approving review and human/loop actor separation are
// unsatisfiable there, not merely unconfigured; every other control keeps its
// full strength.
function fixture(overrides = {}) {
  const config = {
    repository: { owner: 'owner', name: 'repo' },
    baseBranch: 'main',
    mergePolicy: 'auto',
    baseFreshnessStrategy: 'direct-strict',
    loopLogin: 'solo-dev',
    trustedHumanLogins: ['solo-dev'],
    soloOperator: true,
    requiredApprovingReviewCount: 0,
    requireCodeOwnerReviews: false,
  };
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
      labels: [],
      reviewDecision: null,
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
          actor: 'solo-dev',
          labeledAt: '2026-07-24T00:02:00Z',
          roleName: 'admin',
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
        frozenPlanAuthor: 'solo-dev',
        frozenPlanCommentVerified: true,
      },
      lifecycle: {
        complete: true,
        delivered: true,
        headOid: HEAD,
        premergeRecord: true,
        premergeRecordId: `pmr_${'d'.repeat(64)}`,
        premergeRecordHash: 'e'.repeat(64),
        premergeRecordAuthor: 'solo-dev',
        premergeRecordCommentId: 'IC_premerge',
        premergeRecordIssue: 7,
        premergeRecordPullRequest: 12,
      },
      gateEvidenceVerified: true,
      path: 'all-green',
      authorization: undefined,
      checks: [
        { name: 'ci', headOid: HEAD, status: 'COMPLETED', conclusion: 'SUCCESS' },
      ],
      statuses: { complete: true, items: verdictStatuses() },
      checksComplete: true,
      conversationsResolved: true,
      killSwitch: { complete: true, active: false },
    },
    executorIdentity: {
      complete: true,
      login: 'solo-dev',
      id: 9001,
    },
    ...overrides,
  };
}

function pathAFixture() {
  const input = fixture();
  input.config = { ...input.config, mergePolicy: 'ratified' };
  input.pr = {
    ...input.pr,
    labels: ['risk:pure-deletion'],
    path: 'A',
    authorization: {
      complete: true,
      pullRequest: 12,
      actor: 'solo-dev',
      headOid: HEAD,
      label: 'risk:pure-deletion',
      labelEventId: 12001,
      labeledAt: '2026-07-24T00:03:00Z',
      eventVerified: true,
      afterCurrentHead: true,
      roleName: 'admin',
    },
  };
  return input;
}

function selfTest() {
  const base = fixture();
  const pathA = pathAFixture();
  const withStatuses = (items) => fixture({
    pr: { ...base.pr, statuses: { complete: true, items } },
  });
  const cases = [
    ['solo all-green evidence authorizes', base, true],
    ['solo Path-A self-authorization authorizes', pathA, true],
    [
      'non-solo config refuses with the spec-naming reason',
      fixture({ config: { ...base.config, soloOperator: false } }),
      false,
      'docs/specs/simple-delivery.md',
    ],
    [
      'absent solo flag refuses with the spec-naming reason',
      fixture({
        config: (() => {
          const { soloOperator, ...rest } = base.config;
          return rest;
        })(),
      }),
      false,
      'docs/specs/simple-delivery.md',
    ],
    ['solo with a second trusted human is invalid', fixture({
      config: { ...base.config, trustedHumanLogins: ['solo-dev', 'friend'] },
    }), false],
    ['solo trusted list naming someone other than the loop is invalid', fixture({
      config: { ...base.config, trustedHumanLogins: ['friend'] },
    }), false],
    ['negative approving-review count is invalid', fixture({
      config: { ...base.config, requiredApprovingReviewCount: -1 },
    }), false],
    ['branch/body issue mismatch blocks', fixture({
      pr: { ...base.pr, claim: { ok: false, code: 'ISSUE_MISMATCH' } },
    }), false],
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
    ['missing frozen plan blocks', fixture({
      pr: { ...base.pr, ownership: { ...base.pr.ownership, frozenPlanPresent: false } },
    }), false],
    ['unverified frozen-plan comment blocks', fixture({
      pr: { ...base.pr, ownership: { ...base.pr.ownership, frozenPlanCommentVerified: false } },
    }), false],
    ['frozen plan from a non-loop author blocks', fixture({
      pr: { ...base.pr, ownership: { ...base.pr.ownership, frozenPlanAuthor: 'friend' } },
    }), false],
    ['undelivered lifecycle blocks', fixture({
      pr: { ...base.pr, lifecycle: { ...base.pr.lifecycle, delivered: false } },
    }), false],
    ['caller premerge record string never authorizes', fixture({
      pr: {
        ...base.pr,
        lifecycle: { ...base.pr.lifecycle, premergeRecord: 'does-not-exist' },
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
        lifecycle: { ...base.pr.lifecycle, premergeRecordAuthor: 'friend' },
      },
    }), false],
    ['blocked issue blocks', fixture({
      pr: { ...base.pr, linkedIssue: { ...base.pr.linkedIssue, blocked: true } },
    }), false],
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
        linkedIssue: { ...base.pr.linkedIssue, lastEditedAt: '2026-07-24T00:04:00Z' },
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
    ['stale loop-ready label event blocks', fixture({
      pr: {
        ...base.pr,
        linkedIssue: {
          ...base.pr.linkedIssue,
          loopReady: { ...base.pr.linkedIssue.loopReady, labeledAt: '2026-07-24T00:00:30Z' },
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
    ['changes requested blocks', fixture({
      pr: { ...base.pr, reviewDecision: 'CHANGES_REQUESTED' },
    }), false],
    ['pending review request blocks', fixture({
      pr: { ...base.pr, reviewRequests: ['solo-dev'] },
    }), false],
    ['unresolved conversations block', fixture({
      pr: { ...base.pr, conversationsResolved: false },
    }), false],
    ['pending triggered check blocks', fixture({
      pr: {
        ...base.pr,
        checks: [...base.pr.checks, { name: 'optional-ci', headOid: HEAD, status: 'IN_PROGRESS', conclusion: null }],
      },
    }), false],
    ['failing triggered check blocks', fixture({
      pr: {
        ...base.pr,
        checks: base.pr.checks.map((check) =>
          check.name === 'ci' ? { ...check, conclusion: 'FAILURE' } : check),
      },
    }), false],
    ['stale failing check does not gate current head', fixture({
      pr: {
        ...base.pr,
        checks: [...base.pr.checks, { name: 'old-ci', headOid: 'd'.repeat(40), status: 'COMPLETED', conclusion: 'FAILURE' }],
      },
    }), true],
    ['a green agentic-named CheckRun is just another triggered check', fixture({
      pr: {
        ...base.pr,
        checks: [...base.pr.checks, { name: 'agentic/gate', headOid: HEAD, status: 'COMPLETED', conclusion: 'SUCCESS' }],
      },
    }), true],
    ['a red agentic-named CheckRun blocks like any triggered check', fixture({
      pr: {
        ...base.pr,
        checks: [...base.pr.checks, { name: 'agentic/gate', headOid: HEAD, status: 'COMPLETED', conclusion: 'FAILURE' }],
      },
    }), false],
    ['missing agentic/gate verdict status blocks', withStatuses(
      verdictStatuses().filter((status) => status.context !== 'agentic/gate'),
    ), false],
    ['missing agentic/review verdict status blocks', withStatuses(
      verdictStatuses().filter((status) => status.context !== 'agentic/review'),
    ), false],
    ['pending verdict status blocks', withStatuses(
      verdictStatuses().map((status) =>
        status.context === 'agentic/gate' ? { ...status, state: 'pending' } : status),
    ), false],
    ['failing third-party status blocks', withStatuses([
      ...verdictStatuses(),
      { context: 'external/scan', state: 'failure', description: '' },
    ]), false],
    ['pending third-party status blocks', withStatuses([
      ...verdictStatuses(),
      { context: 'external/scan', state: 'pending', description: '' },
    ]), false],
    ['duplicate status contexts block', withStatuses([
      ...verdictStatuses(),
      ...verdictStatuses().filter((status) => status.context === 'agentic/gate'),
    ]), false],
    ['incomplete status evidence blocks', fixture({
      pr: { ...base.pr, statuses: { complete: false, items: verdictStatuses() } },
    }), false],
    ['missing status evidence blocks', fixture({
      pr: { ...base.pr, statuses: undefined },
    }), false],
    ['hard-block label blocks', fixture({
      pr: { ...base.pr, labels: ['do-not-merge'] },
    }), false],
    ['active kill switch blocks', fixture({
      pr: { ...base.pr, killSwitch: { complete: true, active: true } },
    }), false],
    ['incomplete check evidence blocks', fixture({
      pr: { ...base.pr, checksComplete: false },
    }), false],
    ['ratified policy does not authorize the all-green path', fixture({
      config: { ...base.config, mergePolicy: 'ratified' },
    }), false],
    ['Path B needs no human authorization', (() => {
      const input = fixture({ config: { ...base.config, mergePolicy: 'ratified' } });
      input.pr = { ...input.pr, path: 'B', authorization: null };
      return input;
    })(), true],
    ['executor identity mismatch blocks', fixture({
      executorIdentity: { complete: true, login: 'someone-else', id: 9002 },
    }), false],
    ['Path A authorization on old head blocks', (() => {
      const input = pathAFixture();
      input.pr = {
        ...input.pr,
        authorization: { ...input.pr.authorization, headOid: BASE, afterCurrentHead: false },
      };
      return input;
    })(), false],
    ['Path A authorization label older than the current head blocks', (() => {
      const input = pathAFixture();
      input.pr = {
        ...input.pr,
        authorization: { ...input.pr.authorization, afterCurrentHead: false },
      };
      return input;
    })(), false],
    ['Path A authorization without a verified current label event blocks', (() => {
      const input = pathAFixture();
      input.pr = {
        ...input.pr,
        authorization: { ...input.pr.authorization, eventVerified: false },
      };
      return input;
    })(), false],
    ['Path A authorization from outside the trusted list blocks', (() => {
      const input = pathAFixture();
      input.pr = {
        ...input.pr,
        authorization: { ...input.pr.authorization, actor: 'friend' },
      };
      return input;
    })(), false],
  ];
  let passed = 0;
  for (const [name, input, expected, reasonSubstring] of cases) {
    const result = authorizeMerge(input);
    const reasonOkay = reasonSubstring === undefined
      || result.reasons.some((reason) => reason.includes(reasonSubstring));
    if (result.allow === expected && reasonOkay) passed += 1;
    else console.error(`FAIL ${name}: expected allow=${expected}, got ${result.allow} (${result.reasons.join('; ')})`);
  }
  console.log(passed === cases.length ? `self-test OK (${passed} cases)` : `self-test FAILED (${passed}/${cases.length})`);
  return passed === cases.length;
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMain) process.exit(selfTest() ? 0 : 1);
