#!/usr/bin/env node
// SHA-bound verdict publisher. Posts the loop's gate/review verdicts as GitHub
// COMMIT STATUSES so the merge page shows, on the exact head, that this SHA is
// the one the loop gated and the reviewer reviewed — any later push silently
// invalidates the verdict, because statuses are SHA-bound. Statuses are
// PAT-writable; the v0.40 CheckRun publisher required a GitHub App identity
// that a solo operator cannot have (POST /check-runs is App-only), and with
// the shared maintainer login this is evidence, not proof either way
// (docs/specs/simple-delivery.md).
//
// Deliberately narrow:
//   - closed context enum: agentic/gate, agentic/review
//   - only `success` can be posted; absence is the failure signal
//   - the description carries the verdict summary's SHA-256 prefix, so the
//     premerge record can be verified against the live status byte-for-byte
//   - gate executes the configured command itself on the exact clean checkout
//   - review requires authenticated convergence plus the exact clean live checkout
//   - details arrive through a file, never shell arguments
//
// Usage: node tools/agentic/publish-verdict.mjs <gate|review> <40-hex sha>
//        [--review-evidence-file <path>]
//        node tools/agentic/publish-verdict.mjs premerge-create --record-file <path>
//        node tools/agentic/publish-verdict.mjs premerge-observe --attestation-file <path>
//        node tools/agentic/publish-verdict.mjs premerge-append
//          --attestation-file <path> --merge-oid <40-hex sha>
//          --expected-body-hash <64-hex sha256>
//        node tools/agentic/publish-verdict.mjs terminal-finalize
//          --request-file <path> --review-evidence-file <path>

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
  createPremergeRecord,
  derivePremergeRecordObservation,
  createTerminalOutcome,
  parsePremergeRecordComment,
  premergeRecordHash,
  parseAttestation,
  serializePremergeRecord,
  serializeTerminalOutcome,
  serializeAttestation,
  validateAttestation,
} from './attestation-contract.mjs';
import { parseLoopClaim } from './claim-contract.mjs';
import {
  extractConfig,
  validateConfig,
} from './config-contract.mjs';
import { finalizeHead } from './delivery-contract.mjs';
import {
  lifecycleCommentNeverEdited,
  lifecycleIdentityHash,
  parseLifecycleComment,
  parseLifecycleMarker,
  resolveLifecycleCommentChain,
  serializeLifecycleMarker,
  serializeLifecycleSuccessor,
} from './lifecycle-contract.mjs';
import { authorizeReviewPublication } from './review-contract.mjs';
import { snapshotExecutionRepository } from './checkout-contract.mjs';

const CONTEXTS = new Set([
  'gate',
  'review',
]);
const TERMINAL_BLOCKING_ISSUE_LABELS = new Set([
  'automerge:halt',
  'do-not-merge',
  'human:authorize',
  'human:legal',
  'loop-blocked',
  'needs-dependency',
  'needs-human',
  'needs-secret',
]);
const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_REVIEW_EVIDENCE_BYTES = 32 * 1024 * 1024;
const MAX_AUXILIARY_EVIDENCE_BYTES = 1024 * 1024;
const MAX_STATUS_CONTEXTS = 100;
const HASH_RE = /^[0-9a-f]{64}$/;
const REPOSITORY_PART_RE =
  /^[a-z0-9](?:[a-z0-9._-]{0,99})$/;
const HOST_RE =
  /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const POLICY_EVIDENCE_QUERY = `
  query(
    $owner:String!,
    $name:String!,
    $issue:Int!,
    $pullRequest:Int!,
    $cursor:String
  ) {
    viewer { login }
    repository(owner:$owner, name:$name) {
      issue(number:$issue) {
        id
        number
        comments(first:100, after:$cursor) {
          totalCount
          nodes { id author { login } body createdAt updatedAt lastEditedAt }
          pageInfo { hasNextPage endCursor }
        }
      }
      pullRequest(number:$pullRequest) {
        number
        headRefOid
        headRefName
        body
        merged
        mergeCommit { oid }
      }
    }
  }
`;
const LIFECYCLE_BINDING_QUERY = `
  query(
    $owner:String!,
    $name:String!,
    $issue:Int!,
    $pullRequest:Int!,
    $cursor:String
  ) {
    viewer { login }
    repository(owner:$owner, name:$name) {
      issue(number:$issue) {
        id
        number
        comments(first:100, after:$cursor) {
          totalCount
          nodes { id author { login } body createdAt updatedAt lastEditedAt }
          pageInfo { hasNextPage endCursor }
        }
      }
      pullRequest(number:$pullRequest) {
        number
        headRefOid
      }
    }
  }
`;

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
    + `${authorization.reviewEvidenceFingerprint}.`
  );
}

// The description is the status's only payload slot (140 chars); it carries a
// deterministic SHA-256 prefix of the verdict summary so record verification is
// a byte-for-byte string compare, not a parse. The record hash still seals the
// full 64-hex value.
export function buildStatusDescription(ctx, summaryHash) {
  if (!CONTEXTS.has(ctx) || !HASH_RE.test(summaryHash ?? '')) {
    throw new Error('status description requires a closed context and a SHA-256 summary hash');
  }
  return `autoloop ${ctx} verified · sha256:${summaryHash.slice(0, 16)}`;
}

export function buildCommitStatus(ctx, sha, summaryHash) {
  if (!SHA_RE.test(sha ?? '')) throw new Error('status head OID is invalid');
  return {
    state: 'success',
    context: `agentic/${ctx}`,
    description: buildStatusDescription(ctx, summaryHash),
  };
}

function validRepositoryTarget(repository) {
  return (
    repository !== null
    && typeof repository === 'object'
    && !Array.isArray(repository)
    && Object.keys(repository).sort().join(',') === 'host,owner,repo'
    && HOST_RE.test(repository.host ?? '')
    && REPOSITORY_PART_RE.test(repository.owner ?? '')
    && REPOSITORY_PART_RE.test(repository.repo ?? '')
  );
}

export function buildGitHubApiArgs(repository, sha) {
  if (!validRepositoryTarget(repository) || !SHA_RE.test(sha ?? '')) {
    throw new Error('publication repository target is invalid');
  }
  return [
    'api',
    '--hostname',
    repository.host,
    `repos/${repository.owner}/${repository.repo}/statuses/${sha}`,
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

function githubGraphql(repository, query, variables) {
  if (!validRepositoryTarget(repository)) {
    throw new Error('publication repository target is invalid');
  }
  const output = execFileSync(
    'gh',
    [
      'api',
      '--hostname',
      repository.host,
      'graphql',
      '-H',
      'Accept: application/vnd.github+json',
      '-H',
      'X-GitHub-Api-Version: 2026-03-10',
      '--input',
      '-',
    ],
    {
      input: JSON.stringify({ query, variables }),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const response = JSON.parse(output);
  if (response.errors?.length > 0) {
    throw new Error(response.errors.map((error) => error?.message ?? 'GraphQL error').join('; '));
  }
  if (!response.data) throw new Error('GraphQL response did not contain data');
  return response.data;
}

function policyPage(connection) {
  const hasNextPage = connection?.pageInfo?.hasNextPage;
  const endCursor = connection?.pageInfo?.endCursor;
  if (
    typeof hasNextPage !== 'boolean'
    || !Number.isSafeInteger(connection?.totalCount)
    || connection.totalCount < 0
    || !Array.isArray(connection?.nodes)
    || (hasNextPage && (typeof endCursor !== 'string' || endCursor.length === 0))
  ) {
    throw new Error('linked issue comment pagination is incomplete');
  }
  return { hasNextPage, endCursor, totalCount: connection.totalCount };
}

function lifecycleChainInput(comment) {
  return {
    id: comment.id,
    body: comment.body,
    neverEdited: lifecycleCommentNeverEdited(comment),
  };
}

function fetchLifecycleBindingSnapshot(
  repository,
  issueNumber,
  pullRequestNumber,
  commentId,
  fetchGraphql,
  fetchJson,
) {
  const variables = {
    owner: repository.owner,
    name: repository.repo,
    issue: issueNumber,
    pullRequest: pullRequestNumber,
    cursor: null,
  };
  const comments = [];
  const ids = new Set();
  const cursors = new Set();
  let expectedIssueId = null;
  let expectedTotal = null;
  let expectedIdentity = null;
  let expectedHeadOid = null;
  let expectedViewer = null;
  for (;;) {
    const data = fetchGraphql(repository, LIFECYCLE_BINDING_QUERY, variables);
    const issue = data?.repository?.issue;
    const pullRequest = data?.repository?.pullRequest;
    const viewer = data?.viewer?.login;
    if (
      issue?.number !== issueNumber
      || typeof issue?.id !== 'string'
      || issue.id.length === 0
      || pullRequest?.number !== pullRequestNumber
      || !SHA_RE.test(pullRequest?.headRefOid ?? '')
      || typeof viewer !== 'string'
      || viewer.length === 0
    ) {
      throw new Error('lifecycle issue, pull request, or viewer evidence is invalid');
    }
    const identity = stableJson({
      issueId: issue.id,
      pullRequest: pullRequest.number,
      headOid: pullRequest.headRefOid,
      viewer,
    });
    if (expectedIdentity !== null && identity !== expectedIdentity) {
      throw new Error('lifecycle identity changed during pagination');
    }
    expectedIdentity = identity;
    expectedHeadOid = pullRequest.headRefOid;
    expectedViewer = viewer;
    if (expectedIssueId !== null && issue.id !== expectedIssueId) {
      throw new Error('lifecycle issue changed during pagination');
    }
    expectedIssueId = issue.id;
    const page = policyPage(issue.comments);
    if (expectedTotal !== null && page.totalCount !== expectedTotal) {
      throw new Error('lifecycle comment count changed during pagination');
    }
    expectedTotal = page.totalCount;
    for (const comment of issue.comments.nodes) {
      if (
        typeof comment?.id !== 'string'
        || comment.id.length === 0
        || typeof comment?.body !== 'string'
        || typeof comment?.author?.login !== 'string'
        || comment.author.login.length === 0
        || !(comment.lastEditedAt === null || typeof comment.lastEditedAt === 'string')
        || ids.has(comment.id)
      ) {
        throw new Error('lifecycle comments are invalid or duplicated');
      }
      ids.add(comment.id);
      comments.push(comment);
    }
    if (!page.hasNextPage) break;
    if (cursors.has(page.endCursor)) {
      throw new Error('lifecycle comment pagination cursor repeated');
    }
    cursors.add(page.endCursor);
    variables.cursor = page.endCursor;
  }
  if (comments.length !== expectedTotal) {
    throw new Error(
      `lifecycle comment pagination count mismatch (${comments.length}/${expectedTotal})`,
    );
  }
  const roles = new Map();
  for (const author of new Set(
    comments
      .filter((comment) => comment.body.includes('autoloop-lifecycle-v1'))
      .map((comment) => comment.author.login),
  )) {
    const permissionEndpoint =
      `repos/${repository.owner}/${repository.repo}/collaborators/`
      + `${encodeURIComponent(author)}/permission`;
    const firstPermission = fetchJson(repository, permissionEndpoint);
    const secondPermission = fetchJson(repository, permissionEndpoint);
    if (stableJson(firstPermission) !== stableJson(secondPermission)) {
      throw new Error('lifecycle author permission changed during observation');
    }
    roles.set(author, firstPermission?.role_name ?? null);
  }
  const authorized = comments.filter((comment) => {
    const role = roles.get(comment.author.login);
    return ['admin', 'maintain'].includes(role)
      || (comment.author.login === expectedViewer && role === 'write');
  });
  if (authorized.some((comment) => {
    if (!comment.body.includes('autoloop-lifecycle-v1')) return false;
    const parsed = parseLifecycleComment(comment.body);
    return !parsed.ok || parsed.marker.issue !== issueNumber;
  })) {
    throw new Error('authoritative lifecycle comment is malformed or mismatched');
  }
  let chain = resolveLifecycleCommentChain(
    authorized
      .filter((comment) => comment.body.includes('autoloop-lifecycle-v1'))
      .map(lifecycleChainInput),
    commentId,
  );
  if (chain === null) throw new Error('lifecycle comment is missing');
  const rootAuthor = authorized.find(
    (comment) => comment.id === chain.root.id,
  )?.author.login;
  const authorizedMarkers = authorized.filter((comment) =>
    comment.body.includes('autoloop-lifecycle-v1'));
  if (
    typeof rootAuthor !== 'string'
    || authorizedMarkers.some((candidate) => {
      const parsed = parseLifecycleComment(candidate.body);
      return (
        parsed.successor === null
        || parsed.successor?.rootCommentId === chain.root.id
      ) && candidate.author.login !== rootAuthor;
    })
  ) {
    throw new Error('lifecycle chain author changed');
  }
  chain = resolveLifecycleCommentChain(
    authorizedMarkers
      .filter((candidate) => candidate.author.login === rootAuthor)
      .map(lifecycleChainInput),
    commentId,
  );
  const comment = comments.find((candidate) => candidate.id === chain.tip.id);
  if (!comment) throw new Error('lifecycle tip comment is unavailable');
  const role = roles.get(comment.author.login);
  return {
    complete: true,
    issue: issueNumber,
    issueId: expectedIssueId,
    pullRequest: pullRequestNumber,
    headOid: expectedHeadOid,
    viewer: expectedViewer,
    author: comment.author.login,
    authorRole: role,
    rootCommentId: chain.root.id,
    sequence: chain.sequence,
    comment: {
      id: comment.id,
      body: comment.body,
      bodyHash: sha256(comment.body),
    },
  };
}

export function fetchLifecycleBinding(
  repository,
  issue,
  pullRequest,
  commentId,
  adapters = {},
) {
  if (
    !validRepositoryTarget(repository)
    || !Number.isSafeInteger(issue)
    || issue < 1
    || !Number.isSafeInteger(pullRequest)
    || pullRequest < 1
    || !validCommentId(commentId)
  ) {
    throw new Error('lifecycle binding target is invalid');
  }
  const fetchGraphql = adapters.graphql ?? githubGraphql;
  const fetchJson = adapters.rest ?? githubRestJson;
  const first = fetchLifecycleBindingSnapshot(
    repository,
    issue,
    pullRequest,
    commentId,
    fetchGraphql,
    fetchJson,
  );
  const second = fetchLifecycleBindingSnapshot(
    repository,
    issue,
    pullRequest,
    commentId,
    fetchGraphql,
    fetchJson,
  );
  if (stableJson(first) !== stableJson(second)) {
    throw new Error('lifecycle binding evidence changed during observation');
  }
  return first;
}

function githubRestJson(repository, endpoint) {
  if (!validRepositoryTarget(repository)) {
    throw new Error('publication repository target is invalid');
  }
  const output = execFileSync(
    'gh',
    [
      'api',
      '--hostname',
      repository.host,
      endpoint,
      '-H',
      'Accept: application/vnd.github+json',
      '-H',
      'X-GitHub-Api-Version: 2026-03-10',
    ],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return JSON.parse(output);
}

// The combined-status endpoint returns the LATEST status per context — the
// verification unit the record needs. A page holding MAX_STATUS_CONTEXTS
// contexts is treated as possibly truncated and fails closed.
function fetchPublicationStatusSnapshot(repository, headOid, fetchJson) {
  const value = fetchJson(
    repository,
    `repos/${repository.owner}/${repository.repo}/commits/${headOid}`
    + `/status?per_page=${MAX_STATUS_CONTEXTS}`,
  );
  if (
    value?.sha !== headOid
    || !Array.isArray(value?.statuses)
    || value.statuses.length >= MAX_STATUS_CONTEXTS
  ) {
    throw new Error('publication status evidence is incomplete');
  }
  const items = value.statuses.map((status) => {
    if (
      typeof status?.context !== 'string'
      || status.context.length === 0
      || status.context.length > 255
      || typeof status?.state !== 'string'
      || status.state.length === 0
      || (status.description !== null && typeof status.description !== 'string')
    ) {
      throw new Error('publication status evidence is invalid');
    }
    return {
      context: status.context,
      state: status.state,
      description: status.description ?? '',
    };
  });
  const contexts = items.map((status) => status.context);
  if (new Set(contexts).size !== contexts.length) {
    throw new Error('publication status contexts are ambiguous');
  }
  return {
    complete: true,
    items: items.sort((left, right) => left.context.localeCompare(right.context)),
  };
}

export function fetchPublicationStatuses(
  repository,
  headOid,
  fetchJson = githubRestJson,
) {
  if (!SHA_RE.test(headOid ?? '')) throw new Error('publication head OID is invalid');
  const first = fetchPublicationStatusSnapshot(repository, headOid, fetchJson);
  const second = fetchPublicationStatusSnapshot(repository, headOid, fetchJson);
  if (stableJson(first) !== stableJson(second)) {
    throw new Error('publication status evidence changed during observation');
  }
  return first;
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

// A verdict status verifies iff the latest status for its context on the exact
// head is success AND its description is byte-identical to the one this
// publisher derives from the record's summary hash.
function exactVerdictStatus(statuses, ctx, summaryHash) {
  if (statuses?.complete !== true || !Array.isArray(statuses.items)) return null;
  const context = `agentic/${ctx}`;
  const matches = statuses.items.filter((status) => status?.context === context);
  const status = matches.length === 1 ? matches[0] : null;
  return (
    String(status?.state ?? '').toLowerCase() === 'success'
    && status.description === buildStatusDescription(ctx, summaryHash)
  )
    ? status
    : null;
}

function reviewReceiptFingerprint(summary) {
  if (typeof summary !== 'string') return null;
  return /^Authenticated review convergence: [^;\r\n]+; round [1-9]\d*; receipt ([0-9a-f]{64})\.$/u
    .exec(summary)?.[1] ?? null;
}

export function derivePremergeComponentEvidence(record, live) {
  if (
    !record
    || live?.comments?.complete !== true
    || !Array.isArray(live.comments.items)
    || live?.statuses?.complete !== true
    || !Array.isArray(live.statuses.items)
    || live?.delivery?.canMarkDelivered !== true
  ) {
    return { verified: false, code: 'PREMERGE_COMPONENTS_INCOMPLETE' };
  }
  const commentById = (id) =>
    live.comments.items.filter((comment) => comment?.id === id);
  const planMatches = commentById(record.plan.commentId);
  const planComment = planMatches.length === 1 ? planMatches[0] : null;
  const lifecycleMarkerComments = live.comments.items.filter((comment) =>
    typeof comment?.body === 'string'
    && comment.body.includes('autoloop-lifecycle-v1'));
  // Live comment evidence must carry derived edit evidence; a fetcher that omits
  // it is incomplete, not silently unedited.
  if (lifecycleMarkerComments.some((comment) =>
    typeof comment.neverEdited !== 'boolean')) {
    return { verified: false, code: 'PREMERGE_COMPONENTS_INCOMPLETE' };
  }
  const lifecycleAuthorChanged = lifecycleMarkerComments.some((comment) => {
    const parsed = parseLifecycleComment(comment.body);
    return parsed.ok
      && (
        parsed.successor === null
        || parsed.successor.rootCommentId === record.lifecycle.commentId
      )
      && comment?.author?.login !== live.loopAuthor;
  });
  let lifecycleChain = null;
  try {
    lifecycleChain = resolveLifecycleCommentChain(
      lifecycleMarkerComments
        .filter((comment) =>
          comment?.author?.login === live.loopAuthor)
        .map((comment) => ({
          id: comment.id,
          body: comment.body,
          neverEdited: comment.neverEdited,
        })),
      record.lifecycle.commentId,
    );
  } catch {
    lifecycleChain = null;
  }
  const lifecycleComment = lifecycleChain === null
    ? null
    : live.comments.items.find((comment) =>
      comment?.id === lifecycleChain.tip.id);
  const parsedLifecycle = lifecycleChain === null
    ? { ok: false }
    : { ok: true, marker: lifecycleChain.tip.marker };
  if (
    planComment?.author?.login !== live.loopAuthor
    || typeof planComment?.body !== 'string'
    || sha256(planComment.body) !== record.plan.contentHash
    || lifecycleAuthorChanged
    || lifecycleComment?.author?.login !== live.loopAuthor
    || lifecycleChain?.root.id !== record.lifecycle.commentId
    || !parsedLifecycle.ok
    || lifecycleIdentityHash(parsedLifecycle.marker) !== record.lifecycle.identityHash
    || parsedLifecycle.marker.issue !== record.issue
    || parsedLifecycle.marker.pr !== record.pullRequest
    || parsedLifecycle.marker.headOid !== record.headOid
    || parsedLifecycle.marker.planHash !== record.plan.contentHash
    || parsedLifecycle.marker.runIntentHash !== record.run.intentHash
  ) {
    return { verified: false, code: 'PREMERGE_COMMENT_COMPONENT_MISMATCH' };
  }
  // The live statuses carry only the summary-hash prefix (140-char description
  // ceiling), so the full-summary receipt re-parse of the CheckRun era is not
  // reproducible here; the record hash seals the full summaryHash and the
  // finalizer verified the receipt against the summary it hashed.
  const review = exactVerdictStatus(
    live.statuses,
    'review',
    record.review.summaryHash,
  );
  const gate = exactVerdictStatus(
    live.statuses,
    'gate',
    record.gate.summaryHash,
  );
  if (!review || !gate) {
    return { verified: false, code: 'PREMERGE_CHECK_COMPONENT_MISMATCH' };
  }
  const ciEvidenceHash =
    live.delivery.liveEvidence?.provenance?.evidenceFingerprint ?? null;
  if (
    live.delivery.headOid !== record.headOid
    || ciEvidenceHash === null
    || ciEvidenceHash !== record.ci.evidenceHash
  ) {
    return { verified: false, code: 'PREMERGE_CI_COMPONENT_MISMATCH' };
  }
  return {
    verified: true,
    code: 'PREMERGE_COMPONENTS_VERIFIED',
    lifecycleMarker: parsedLifecycle.marker,
    ciEvidenceHash,
  };
}

export function fetchPolicyPublicationEvidence(
  repository,
  attestation,
  adapters = {},
) {
  const errors = validateAttestation(attestation, {
    kind: 'policy',
    headOid: attestation?.headOid,
  });
  if (errors.length > 0) throw new Error(errors.join('; '));
  if (!validRepositoryTarget(repository)) {
    throw new Error('publication repository target is invalid');
  }
  const fetchGraphql = typeof adapters === 'function'
    ? adapters
    : adapters.graphql ?? githubGraphql;
  const fetchStatuses = typeof adapters === 'object' && adapters.statuses
    ? adapters.statuses
    : fetchPublicationStatuses;
  const fetchDelivery = typeof adapters === 'object' && adapters.delivery
    ? adapters.delivery
    : (request) => finalizeHead(request, {
        repositoryRoot: adapters.repositoryRoot ?? process.cwd(),
      });
  const variables = {
    owner: repository.owner,
    name: repository.repo,
    issue: attestation.issue,
    pullRequest: attestation.pullRequest,
    cursor: null,
  };
  const comments = [];
  const commentIds = new Set();
  const cursors = new Set();
  let expectedIssueId = null;
  let expectedTotal = null;
  let expectedLiveIdentity = null;
  let live = null;
  for (;;) {
    const data = fetchGraphql(repository, POLICY_EVIDENCE_QUERY, variables);
    const issue = data?.repository?.issue;
    const pullRequest = data?.repository?.pullRequest;
    const loopAuthor = data?.viewer?.login;
    if (
      !issue
      || issue.number !== attestation.issue
      || !validRepositoryTarget(repository)
      || typeof issue.id !== 'string'
      || issue.id.length === 0
      || typeof loopAuthor !== 'string'
      || loopAuthor.length === 0
      || !pullRequest
    ) {
      throw new Error('linked issue, pull request, or publisher identity is unavailable');
    }
    if (expectedIssueId !== null && expectedIssueId !== issue.id) {
      throw new Error('linked issue identity changed during pagination');
    }
    expectedIssueId = issue.id;
    const liveIdentity = stableJson({
      loopAuthor,
      issueId: issue.id,
      issueNumber: issue.number,
      pullRequestNumber: pullRequest.number,
      headOid: pullRequest.headRefOid,
      headRefName: pullRequest.headRefName,
      body: pullRequest.body,
      merged: pullRequest.merged,
      mergeOid: pullRequest.mergeCommit?.oid ?? null,
    });
    if (expectedLiveIdentity !== null && expectedLiveIdentity !== liveIdentity) {
      throw new Error('linked issue or pull request changed during pagination');
    }
    expectedLiveIdentity = liveIdentity;
    const page = policyPage(issue.comments);
    if (expectedTotal !== null && expectedTotal !== page.totalCount) {
      throw new Error('linked issue comment count changed during pagination');
    }
    expectedTotal = page.totalCount;
    for (const comment of issue.comments.nodes) {
      if (commentIds.has(comment?.id)) {
        throw new Error('linked issue comment pagination repeated a comment');
      }
      commentIds.add(comment?.id);
      comments.push({
        id: comment?.id,
        author: { login: comment?.author?.login ?? null },
        body: comment?.body,
        neverEdited: lifecycleCommentNeverEdited(comment),
      });
    }
    live = {
      complete: true,
      loopAuthor,
      issue: { number: issue.number, id: issue.id },
      pullRequest: {
        number: pullRequest.number,
        headOid: pullRequest.headRefOid,
        headRefName: pullRequest.headRefName,
        body: pullRequest.body,
        merged: pullRequest.merged,
        mergeOid: pullRequest.mergeCommit?.oid ?? null,
      },
    };
    if (!page.hasNextPage) break;
    if (cursors.has(page.endCursor)) {
      throw new Error('linked issue comment pagination repeated a cursor');
    }
    cursors.add(page.endCursor);
    variables.cursor = page.endCursor;
  }
  if (comments.length !== expectedTotal) {
    throw new Error(
      `linked issue comment pagination count mismatch (${comments.length}/${expectedTotal})`,
    );
  }
  const delivery = fetchDelivery({
    schemaVersion: 1,
    repository: `${repository.owner}/${repository.repo}`,
    pullRequest: attestation.pullRequest,
    committedHead: attestation.headOid,
    reviewedHead: attestation.headOid,
    gatedHead: attestation.headOid,
  });
  return {
    ...live,
    comments: { complete: true, items: comments },
    statuses: fetchStatuses(repository, attestation.headOid),
    delivery,
  };
}

export function authorizePolicyPublication(attestation, live, options = {}) {
  const errors = validateAttestation(attestation, {
    kind: 'policy',
    headOid: attestation?.headOid,
  });
  if (errors.length > 0) return { authorized: false, code: 'POLICY_ATTESTATION_INVALID' };
  const claim = parseLoopClaim({
    branch: live?.pullRequest?.headRefName,
    body: live?.pullRequest?.body,
  });
  if (
    live?.complete !== true
    || live?.issue?.number !== attestation.issue
    || live?.pullRequest?.number !== attestation.pullRequest
    || live.pullRequest.headOid !== attestation.headOid
    || !claim.valid
    || claim.issue !== attestation.issue
    || live?.loopAuthor !== attestation.premergeRecordAuthor
    || (
      options.requireOutcomeAbsent !== false
      && live?.pullRequest?.merged !== false
    )
  ) {
    return { authorized: false, code: 'POLICY_LIVE_IDENTITY_MISMATCH' };
  }
  const observation = derivePremergeRecordObservation(live.comments, {
    issue: attestation.issue,
    headOid: attestation.headOid,
    recordId: attestation.premergeRecordId,
    bodyHash: attestation.premergeRecordHash,
    author: attestation.premergeRecordAuthor,
    requireOutcomeAbsent: options.requireOutcomeAbsent !== false,
  });
  if (
    observation.verified !== true
    || observation.pullRequest !== attestation.pullRequest
  ) {
    return {
      authorized: false,
      code: observation.code ?? 'POLICY_PREMERGE_RECORD_UNVERIFIED',
      observation,
    };
  }
  const components = derivePremergeComponentEvidence(observation.record, live);
  if (!components.verified) {
    return {
      authorized: false,
      code: components.code,
      observation,
      components,
    };
  }
  return {
    authorized: true,
    code: 'POLICY_PREMERGE_RECORD_VERIFIED',
    observation,
    components,
  };
}

export function policyAttestationForRecord(record, author, delivered = true) {
  const body = serializePremergeRecord(record);
  const attestation = {
    kind: 'policy',
    v: 1,
    headOid: record.headOid,
    issue: record.issue,
    pullRequest: record.pullRequest,
    delivered,
    premergeRecordId: record.recordId,
    premergeRecordHash: sha256(body),
    premergeRecordAuthor: author,
  };
  const errors = validateAttestation(attestation, {
    kind: 'policy',
    headOid: record.headOid,
  });
  if (errors.length > 0) throw new Error(errors.join('; '));
  return attestation;
}

function fetchPublisherLogin(repository) {
  const data = githubGraphql(repository, 'query { viewer { login } }', {});
  const login = data?.viewer?.login;
  if (typeof login !== 'string' || login.length === 0) {
    throw new Error('publisher login is unavailable');
  }
  return login;
}

function addIssueComment(repository, issueId, body) {
  const data = githubGraphql(
    repository,
    `mutation($subjectId:ID!,$body:String!){
      addComment(input:{subjectId:$subjectId,body:$body}){
        commentEdge{node{id body author{login}}}
      }
    }`,
    { subjectId: issueId, body },
  );
  const comment = data?.addComment?.commentEdge?.node;
  if (
    typeof comment?.id !== 'string'
    || comment.body !== body
    || typeof comment?.author?.login !== 'string'
  ) {
    throw new Error('GitHub returned a mismatched premerge comment');
  }
  return {
    id: comment.id,
    author: { login: comment.author.login },
    body: comment.body,
  };
}

function operationalAdapters(overrides = {}) {
  return {
    publisherLogin: overrides.publisherLogin ?? fetchPublisherLogin,
    fetchEvidence: overrides.fetchEvidence ?? (
      (repository, attestation) => fetchPolicyPublicationEvidence(
        repository,
        attestation,
        { repositoryRoot: overrides.repositoryRoot ?? process.cwd() },
      )
    ),
    addComment: overrides.addComment ?? addIssueComment,
  };
}

export function lifecycleFactsFromPremergeObservation(observation) {
  const outcome = observation?.outcome;
  return {
    premergeRecord: observation,
    finalRecord: {
      complete: observation?.complete === true,
      exists: outcome !== null && outcome !== undefined,
      verified: observation?.verified === true && outcome !== null && outcome !== undefined,
      premergeRecord: observation?.id ?? null,
      premergeRecordHash: observation?.bodyHash ?? null,
      commentId: observation?.commentId ?? null,
      headOid: outcome?.headOid ?? observation?.headOid ?? null,
      mergeOid: outcome?.mergeOid ?? null,
    },
  };
}

export function createPremergeRecordComment(record, repository, overrides = {}) {
  const adapters = operationalAdapters(overrides);
  const author = adapters.publisherLogin(repository);
  const attestation = policyAttestationForRecord(record, author);
  let live = adapters.fetchEvidence(repository, attestation);
  const components = derivePremergeComponentEvidence(record, live);
  if (!components.verified) {
    throw new Error(`premerge components are not live and complete (${components.code})`);
  }
  let observation = derivePremergeRecordObservation(live.comments, {
    issue: record.issue,
    headOid: record.headOid,
    recordId: record.recordId,
    bodyHash: attestation.premergeRecordHash,
    author,
    requireOutcomeAbsent: true,
  });
  let created = false;
  if (observation.exists === true && observation.verified !== true) {
    throw new Error(`premerge record conflicts with live evidence (${observation.code})`);
  }
  if (observation.exists !== true) {
    adapters.addComment(repository, live.issue.id, serializePremergeRecord(record));
    created = true;
    live = adapters.fetchEvidence(repository, attestation);
    observation = derivePremergeRecordObservation(live.comments, {
      issue: record.issue,
      headOid: record.headOid,
      recordId: record.recordId,
      bodyHash: attestation.premergeRecordHash,
      author,
      requireOutcomeAbsent: true,
    });
  }
  const authorization = authorizePolicyPublication(attestation, live);
  if (!authorization.authorized || observation.verified !== true) {
    throw new Error(
      `premerge record postcondition is unverified (${authorization.code ?? observation.code})`,
    );
  }
  return {
    created,
    attestation,
    observation: authorization.observation,
    lifecycleFacts: lifecycleFactsFromPremergeObservation(authorization.observation),
  };
}

export function observePremergeRecord(attestation, repository, overrides = {}) {
  const adapters = operationalAdapters(overrides);
  const live = adapters.fetchEvidence(repository, attestation);
  const authorization = authorizePolicyPublication(attestation, live, {
    requireOutcomeAbsent: overrides.requireOutcomeAbsent !== false,
  });
  if (!authorization.authorized) {
    throw new Error(`premerge record is unverified (${authorization.code})`);
  }
  return {
    attestation,
    live,
    ...authorization,
    lifecycleFacts: lifecycleFactsFromPremergeObservation(authorization.observation),
  };
}

export function appendPremergeTerminalOutcome(
  attestation,
  mergeOid,
  repository,
  overrides = {},
) {
  const adapters = operationalAdapters(overrides);
  let observed = observePremergeRecord(attestation, repository, {
    ...overrides,
    requireOutcomeAbsent: false,
  });
  if (
    observed.live.pullRequest.merged !== true
    || observed.live.pullRequest.mergeOid !== mergeOid
  ) {
    throw new Error('live pull request does not prove the exact terminal merge outcome');
  }
  const record = observed.observation.record;
  const outcome = createTerminalOutcome(record, mergeOid);
  const comment = observed.live.comments.items.find((item) =>
    item.id === observed.observation.commentId);
  if (!comment) throw new Error('verified premerge comment disappeared');
  const changed = observed.observation.outcome === null;
  if (
    changed
    && overrides.expectedCommentBodyHash !== undefined
    && observed.observation.commentBodyHash !== overrides.expectedCommentBodyHash
  ) {
    throw new Error('premerge comment changed since lifecycle reconciliation');
  }
  if (changed) {
    adapters.addComment(
      repository,
      observed.live.issue.id,
      serializeTerminalOutcome(outcome, record),
    );
    observed = observePremergeRecord(attestation, repository, {
      ...overrides,
      requireOutcomeAbsent: false,
    });
  }
  if (
    observed.observation.outcome?.mergeOid !== mergeOid
    || observed.observation.outcome?.recordId !== attestation.premergeRecordId
  ) {
    throw new Error('terminal outcome append postcondition is unverified');
  }
  return {
    changed,
    attestation,
    observation: observed.observation,
    lifecycleFacts: lifecycleFactsFromPremergeObservation(observed.observation),
    outcome,
  };
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

function loadPublicationConfig(repositoryRoot) {
  const statePath = resolve(repositoryRoot, 'docs', 'agentic', 'STATE.md');
  const config = extractConfig(
    readBoundedNoFollow(
      statePath,
      MAX_AUXILIARY_EVIDENCE_BYTES,
    ).toString('utf8'),
  );
  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new Error(`ProjectConfig is invalid: ${errors.join('; ')}`);
  }
  return config;
}

function executeGateSummary(snapshot, config) {
  const result = runGate(config.gate.command, snapshot.checkout.root);
  const after = snapshotExecutionRepository(snapshot.checkout.root);
  return gateSummary(
    config,
    snapshot.checkout.headOid,
    snapshot,
    after,
    result,
  );
}

function validPublishedStatus(status, payload) {
  return (
    status?.state === payload.state
    && status?.context === payload.context
    && status?.description === payload.description
  );
}

export function postCommitStatus(
  repository,
  headOid,
  payload,
  execute = execFileSync,
) {
  const output = execute(
    'gh',
    buildGitHubApiArgs(repository, headOid),
    {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000,
    },
  );
  const status = JSON.parse(output);
  if (!validPublishedStatus(status, payload)) {
    throw new Error('GitHub returned a mismatched commit status');
  }
  return status;
}

// Idempotent SHA-bound publication: reuse the exact status when it is already
// the latest for its context, refuse when the latest conflicts (same context,
// different verdict payload — someone else wrote our reserved context), and
// verify by readback after posting. The SHA binding is the API path itself.
export function ensurePublishedStatus(
  context,
  headOid,
  summaryHash,
  repository,
  overrides = {},
) {
  const payload = buildCommitStatus(context, headOid, summaryHash);
  const fetchStatuses = overrides.fetchStatuses ?? fetchPublicationStatuses;
  const publish = overrides.publish ?? postCommitStatus;
  const select = (snapshot) => {
    if (snapshot?.complete !== true || !Array.isArray(snapshot.items)) {
      throw new Error(`${payload.context} status evidence is incomplete`);
    }
    const matches = snapshot.items.filter(
      (status) => status?.context === payload.context,
    );
    if (matches.length === 0) return null;
    if (
      matches.length !== 1
      || !validPublishedStatus(matches[0], payload)
    ) {
      throw new Error(`${payload.context} latest status conflicts with evidence`);
    }
    return matches[0];
  };
  const existing = select(fetchStatuses(repository, headOid));
  if (existing) return existing;
  try {
    publish(repository, headOid, payload);
  } catch (error) {
    const recovered = select(fetchStatuses(repository, headOid));
    if (recovered) return recovered;
    throw error;
  }
  const observed = select(fetchStatuses(repository, headOid));
  if (!observed) {
    throw new Error(`${payload.context} status postcondition is unverified`);
  }
  return observed;
}

function githubRestMutation(repository, endpoint, method, input = null) {
  if (
    !validRepositoryTarget(repository)
    || !new Set(['DELETE', 'POST']).has(method)
  ) {
    throw new Error('terminal GitHub mutation target is invalid');
  }
  const args = [
    'api',
    '--hostname',
    repository.host,
    endpoint,
    '--method',
    method,
    '-H',
    'Accept: application/vnd.github+json',
    '-H',
    'X-GitHub-Api-Version: 2026-03-10',
  ];
  if (input !== null) args.push('--input', '-');
  const output = execFileSync('gh', args, {
    ...(input === null ? {} : { input: JSON.stringify(input) }),
    encoding: 'utf8',
    stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    timeout: 15000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return output.trim().length === 0 ? null : JSON.parse(output);
}

function fetchIssueLabelSnapshot(repository, issue, fetchJson) {
  const labels = [];
  const identities = new Set();
  for (let page = 1; page <= 101; page += 1) {
    const values = fetchJson(
      repository,
      `repos/${repository.owner}/${repository.repo}/issues/${issue}`
      + `/labels?per_page=100&page=${page}`,
    );
    if (!Array.isArray(values) || values.length > 100) {
      throw new Error('terminal issue-label pagination is incomplete');
    }
    for (const label of values) {
      if (
        !Number.isSafeInteger(label?.id)
        || label.id < 1
        || typeof label?.name !== 'string'
        || label.name.length === 0
        || label.name.length > 255
        || identities.has(label.id)
      ) {
        throw new Error('terminal issue-label evidence is invalid');
      }
      identities.add(label.id);
      labels.push(label.name);
    }
    if (values.length < 100) {
      if (new Set(labels.map((label) => label.toLowerCase())).size !== labels.length) {
        throw new Error('terminal issue labels are ambiguous');
      }
      return labels.sort();
    }
  }
  throw new Error('terminal issue-label pagination exceeded its bound');
}

function fetchTerminalStateSnapshot(repository, issue, pullRequest, fetchJson) {
  const pr = fetchJson(
    repository,
    `repos/${repository.owner}/${repository.repo}/pulls/${pullRequest}`,
  );
  const linkedIssue = fetchJson(
    repository,
    `repos/${repository.owner}/${repository.repo}/issues/${issue}`,
  );
  if (
    pr?.number !== pullRequest
    || pr?.state !== 'open'
    || pr?.merged !== false
    || typeof pr?.draft !== 'boolean'
    || !SHA_RE.test(pr?.head?.sha ?? '')
    || typeof pr?.node_id !== 'string'
    || pr.node_id.length === 0
    || linkedIssue?.number !== issue
    || linkedIssue?.state !== 'open'
    || typeof linkedIssue?.node_id !== 'string'
    || linkedIssue.node_id.length === 0
  ) {
    throw new Error('terminal pull request or issue evidence is invalid');
  }
  return {
    complete: true,
    issue,
    issueNodeId: linkedIssue.node_id,
    pullRequest,
    pullRequestNodeId: pr.node_id,
    headOid: pr.head.sha,
    draft: pr.draft,
    labels: fetchIssueLabelSnapshot(repository, issue, fetchJson),
  };
}

export function fetchTerminalState(
  repository,
  issue,
  pullRequest,
  fetchJson = githubRestJson,
) {
  const first = fetchTerminalStateSnapshot(
    repository,
    issue,
    pullRequest,
    fetchJson,
  );
  const second = fetchTerminalStateSnapshot(
    repository,
    issue,
    pullRequest,
    fetchJson,
  );
  if (stableJson(first) !== stableJson(second)) {
    throw new Error('terminal GitHub evidence changed during observation');
  }
  return first;
}

function markPullRequestReady(repository, state) {
  const data = githubGraphql(
    repository,
    `mutation($id:ID!){
      markPullRequestReadyForReview(input:{pullRequestId:$id}){
        pullRequest{number isDraft headRefOid}
      }
    }`,
    { id: state.pullRequestNodeId },
  );
  const pullRequest = data?.markPullRequestReadyForReview?.pullRequest;
  if (
    pullRequest?.number !== state.pullRequest
    || pullRequest?.isDraft !== false
    || pullRequest?.headRefOid !== state.headOid
  ) {
    throw new Error('pull-request ready mutation postcondition is invalid');
  }
}

function markIssueDelivered(repository, state) {
  const remove = state.labels.filter(
    (label) => label === 'loop-started' || label.startsWith('loop:'),
  );
  for (const label of remove) {
    githubRestMutation(
      repository,
      `repos/${repository.owner}/${repository.repo}/issues/${state.issue}`
      + `/labels/${encodeURIComponent(label)}`,
      'DELETE',
    );
  }
  if (!state.labels.includes('loop-delivered')) {
    const response = githubRestMutation(
      repository,
      `repos/${repository.owner}/${repository.repo}/issues/${state.issue}/labels`,
      'POST',
      { labels: ['loop-delivered'] },
    );
    if (
      !Array.isArray(response)
      || !response.some((label) => label?.name === 'loop-delivered')
    ) {
      throw new Error('loop-delivered mutation postcondition is invalid');
    }
  }
}

function lifecycleSuccessorBody(binding, rootCommentId, marker) {
  if (
    binding?.rootCommentId !== rootCommentId
    || !Number.isSafeInteger(binding.sequence)
    || binding.sequence < 0
    || binding.comment?.id === undefined
    || !HASH_RE.test(binding.comment?.bodyHash ?? '')
  ) {
    throw new Error('lifecycle successor predecessor is invalid');
  }
  return serializeLifecycleSuccessor(marker, {
    v: 1,
    rootCommentId,
    previousCommentId: binding.comment.id,
    previousBodyHash: binding.comment.bodyHash,
    sequence: binding.sequence + 1,
  });
}

export function bindFinalizedLifecycleHead(
  record,
  repository,
  overrides = {},
) {
  const observe = overrides.observe ?? (
    (issue, pullRequest, commentId) => fetchLifecycleBinding(
      repository,
      issue,
      pullRequest,
      commentId,
    )
  );
  const append = overrides.append ?? (
    (target, binding, body) => addIssueComment(
      target,
      binding.issueId,
      body,
    )
  );
  let binding = observe(
    record.issue,
    record.pullRequest,
    record.lifecycle.commentId,
  );
  let changed = false;
  let parsed = parseLifecycleMarker(binding?.comment?.body);
  if (
    binding?.complete !== true
    || binding.issue !== record.issue
    || binding.pullRequest !== record.pullRequest
    || binding.headOid !== record.headOid
    || binding.rootCommentId !== record.lifecycle.commentId
    || !HASH_RE.test(binding.comment?.bodyHash ?? '')
    || !parsed.ok
    || parsed.marker.issue !== record.issue
    || parsed.marker.pr !== record.pullRequest
    || parsed.marker.runIntentHash !== record.run.intentHash
    || parsed.marker.planHash !== record.plan.contentHash
    || (
      parsed.marker.planCommentId !== undefined
      && parsed.marker.planCommentId !== record.plan.commentId
    )
    || parsed.marker.revisionIntent !== undefined
  ) {
    throw new Error('live lifecycle marker does not match terminal input');
  }
  const requiresBinding = (
    parsed.marker.headOid === undefined
    || parsed.marker.planCommentId === undefined
    || parsed.marker.epoch === undefined
  );
  if (requiresBinding) {
    if (
      !(
        parsed.marker.phase === 'draft-pr'
        && parsed.marker.headOid === undefined
        || parsed.marker.phase === 'ready-head'
        && parsed.marker.headOid === record.headOid
      )
      || parsed.marker.premergeRecord !== undefined
      || parsed.marker.premergeRecordHash !== undefined
      || parsed.marker.premergeRecordCommentId !== undefined
    ) {
      throw new Error('lifecycle marker cannot accept a finalized-head binding');
    }
    const expectedBodyHash = binding.comment.bodyHash;
    const current = observe(
      record.issue,
      record.pullRequest,
      record.lifecycle.commentId,
    );
    if (
      current?.comment?.bodyHash !== expectedBodyHash
      || current.headOid !== record.headOid
      || current.rootCommentId !== record.lifecycle.commentId
      || current.sequence !== binding.sequence
    ) {
      throw new Error('lifecycle marker changed before finalized-head binding');
    }
    const marker = {
      ...parsed.marker,
      epoch: parsed.marker.epoch ?? 1,
      phase: 'ready-head',
      planCommentId: parsed.marker.planCommentId ?? record.plan.commentId,
      headOid: record.headOid,
    };
    append(
      repository,
      current,
      lifecycleSuccessorBody(
        current,
        record.lifecycle.commentId,
        marker,
      ),
    );
    changed = true;
    binding = observe(
      record.issue,
      record.pullRequest,
      record.lifecycle.commentId,
    );
    parsed = parseLifecycleMarker(binding?.comment?.body);
  }
  const identityHash = parsed.ok
    ? lifecycleIdentityHash(parsed.marker)
    : null;
  if (
    binding?.complete !== true
    || binding.headOid !== record.headOid
    || binding.rootCommentId !== record.lifecycle.commentId
    || !parsed.ok
    || parsed.marker.headOid !== record.headOid
    || !['ready-head', 'premerge-record'].includes(parsed.marker.phase)
    || parsed.marker.issue !== record.issue
    || parsed.marker.pr !== record.pullRequest
    || parsed.marker.planHash !== record.plan.contentHash
    || parsed.marker.planCommentId !== record.plan.commentId
    || parsed.marker.runIntentHash !== record.run.intentHash
    || !HASH_RE.test(identityHash ?? '')
  ) {
    throw new Error('finalized lifecycle head postcondition is unverified');
  }
  return {
    verified: true,
    marker: parsed.marker,
    identityHash,
    changed,
  };
}

function bindPremergeLifecycle(record, created, repository, overrides = {}) {
  const observe = overrides.observe ?? (
    (attestation, target) => observePremergeRecord(
      attestation,
      target,
      { repositoryRoot: overrides.repositoryRoot ?? process.cwd() },
    )
  );
  const append = overrides.append ?? (
    (target, issueId, body) => addIssueComment(target, issueId, body)
  );
  const resolveObservedChain = (value) => {
    const items = value?.live?.comments?.items;
    if (!Array.isArray(items)) {
      throw new Error('lifecycle comment evidence is incomplete');
    }
    const roots = items.filter((comment) =>
      comment?.id === record.lifecycle.commentId);
    if (
      roots.length !== 1
      || typeof roots[0]?.author?.login !== 'string'
    ) {
      throw new Error('lifecycle root comment is missing or ambiguous');
    }
    const author = roots[0].author.login;
    const markerItems = items.filter((comment) =>
      typeof comment?.body === 'string'
      && comment.body.includes('autoloop-lifecycle-v1'));
    if (markerItems.some((comment) => {
      const parsed = parseLifecycleComment(comment.body);
      return parsed.ok
        && (
          parsed.successor === null
          || parsed.successor.rootCommentId === record.lifecycle.commentId
        )
        && comment?.author?.login !== author;
    })) {
      throw new Error('lifecycle chain author changed');
    }
    if (markerItems.some((comment) => typeof comment.neverEdited !== 'boolean')) {
      throw new Error('lifecycle comment edit evidence is incomplete');
    }
    const chain = resolveLifecycleCommentChain(
      markerItems
        .filter((comment) =>
          comment?.author?.login === author
        )
        .map((comment) => ({
          id: comment.id,
          body: comment.body,
          neverEdited: comment.neverEdited,
        })),
      record.lifecycle.commentId,
    );
    if (chain === null) throw new Error('lifecycle comment chain is missing');
    return chain;
  };
  let observed = observe(created.attestation, repository);
  let chain = resolveObservedChain(observed);
  let comment = observed.live.comments.items.find((candidate) =>
    candidate?.id === chain.tip.id);
  let parsed = { ok: true, marker: chain.tip.marker };
  if (
    typeof comment?.body !== 'string'
    || !parsed.ok
    || lifecycleIdentityHash(parsed.marker) !== record.lifecycle.identityHash
    || parsed.marker.issue !== record.issue
    || parsed.marker.pr !== record.pullRequest
    || parsed.marker.headOid !== record.headOid
  ) {
    throw new Error('lifecycle marker does not match the premerge record');
  }
  const expected = {
    id: created.observation.id,
    bodyHash: created.observation.bodyHash,
    commentId: created.observation.commentId,
  };
  const bound = (
    parsed.marker.premergeRecord === expected.id
    && parsed.marker.premergeRecordHash === expected.bodyHash
    && parsed.marker.premergeRecordCommentId === expected.commentId
  );
  if (!bound) {
    if (
      parsed.marker.premergeRecord !== undefined
      || parsed.marker.premergeRecordHash !== undefined
      || parsed.marker.premergeRecordCommentId !== undefined
      || parsed.marker.phase !== 'ready-head'
    ) {
      throw new Error('lifecycle marker has a conflicting terminal binding');
    }
    const marker = {
      ...parsed.marker,
      phase: 'premerge-record',
      premergeRecord: expected.id,
      premergeRecordHash: expected.bodyHash,
      premergeRecordCommentId: expected.commentId,
    };
    append(
      repository,
      observed.live.issue.id,
      serializeLifecycleSuccessor(marker, {
        v: 1,
        rootCommentId: record.lifecycle.commentId,
        previousCommentId: chain.tip.id,
        previousBodyHash: sha256(comment.body),
        sequence: chain.sequence + 1,
      }),
    );
    observed = observe(created.attestation, repository);
    chain = resolveObservedChain(observed);
    comment = observed.live.comments.items.find((candidate) =>
      candidate?.id === chain.tip.id);
    parsed = { ok: true, marker: chain.tip.marker };
  }
  const current = parsed;
  if (
    typeof comment?.body !== 'string'
    || !current.ok
    || current.marker.premergeRecord !== expected.id
    || current.marker.premergeRecordHash !== expected.bodyHash
    || current.marker.premergeRecordCommentId !== expected.commentId
  ) {
    throw new Error('lifecycle premerge binding postcondition is unverified');
  }
  return { verified: true, marker: current.marker, observation: observed.observation };
}

function terminalStateMatches(state, input) {
  return (
    state?.complete === true
    && state.issue === input.record.issue
    && state.pullRequest === input.record.pullRequest
    && state.headOid === input.record.headOid
    && typeof state.draft === 'boolean'
    && Array.isArray(state.labels)
    && state.labels.every(
      (label) => typeof label === 'string' && label.length > 0,
    )
    && new Set(state.labels).size === state.labels.length
    && state.labels.includes('loop-ready')
    && !state.labels.some((label) =>
      TERMINAL_BLOCKING_ISSUE_LABELS.has(label))
  );
}

function deliveredState(state) {
  return (
    state.draft === false
    && state.labels.includes('loop-delivered')
    && !state.labels.includes('loop-started')
    && !state.labels.some((label) => label.startsWith('loop:'))
  );
}

export function finalizeTerminalDelivery(input, context = {}) {
  const errors = validateTerminalInput(input);
  if (errors.length > 0) throw new Error(errors.join('; '));
  const repositoryRoot = context.repositoryRoot ?? process.cwd();
  const adapters = context.adapters ?? {};
  const snapshot = (adapters.snapshot ?? snapshotExecutionRepository)(repositoryRoot);
  if (
    snapshot?.checkout?.clean !== true
    || snapshot.checkout.headOid !== input.record.headOid
    || !validRepositoryTarget(snapshot.repository)
  ) {
    throw new Error('terminal finalization requires the exact clean live checkout');
  }
  const config = (adapters.config ?? loadPublicationConfig)(
    snapshot.checkout.root,
  );
  const configErrors = validateConfig(config);
  if (configErrors.length > 0) {
    throw new Error(`ProjectConfig is invalid: ${configErrors.join('; ')}`);
  }
  const bindFinalizedHead = adapters.bindFinalizedLifecycle ?? (
    (record) => bindFinalizedLifecycleHead(
      record,
      snapshot.repository,
      { repositoryRoot: snapshot.checkout.root },
    )
  );
  const finalizedLifecycle = bindFinalizedHead(
    input.record,
    snapshot.repository,
  );
  if (
    finalizedLifecycle?.verified !== true
    || !HASH_RE.test(finalizedLifecycle.identityHash ?? '')
    || finalizedLifecycle.marker?.headOid !== input.record.headOid
  ) {
    throw new Error('finalized lifecycle identity is unverified');
  }
  input = {
    ...input,
    record: {
      ...input.record,
      lifecycle: {
        commentId: input.record.lifecycle.commentId,
        identityHash: finalizedLifecycle.identityHash,
      },
    },
  };
  // The only implemented non-manual mode is solo (docs/specs/simple-delivery.md):
  // one credential writes everything, so App-separated multi-actor evidence is
  // unprovable by construction. A non-manual config that has not recorded both
  // solo acknowledgements is a typed refusal, not a degraded run.
  const nonManual = config.merge.policy !== 'manual';
  if (
    nonManual
    && (
      config.merge.soloOperatorAcknowledged !== true
      || config.merge.unverifiedInvocationAcknowledged !== true
    )
  ) {
    throw new Error(
      'non-manual terminal finalization is solo-only: record '
      + 'merge.soloOperatorAcknowledged and merge.unverifiedInvocationAcknowledged '
      + '(docs/specs/simple-delivery.md) or use merge.policy manual',
    );
  }
  const review = (adapters.review ?? reviewSummary)(
    input.reviewEvidence,
    input.record.headOid,
    snapshot.checkout,
  );
  if (reviewReceiptFingerprint(review) !== input.record.run.receiptFingerprint) {
    throw new Error('review receipt does not match the terminal record');
  }
  const gate = (adapters.gate ?? executeGateSummary)(snapshot, config);
  const afterGate = (adapters.snapshot ?? snapshotExecutionRepository)(
    snapshot.checkout.root,
  );
  if (!samePublicationSnapshot(snapshot, afterGate)) {
    throw new Error('checkout or publication repository changed during terminal gate');
  }
  const ensure = adapters.ensureStatus ?? (
    (name, headOid, summaryHash) => ensurePublishedStatus(
      name,
      headOid,
      summaryHash,
      snapshot.repository,
    )
  );
  const statuses = {
    review: ensure('review', input.record.headOid, sha256(review)),
    gate: ensure('gate', input.record.headOid, sha256(gate)),
  };
  const deliveryRequest = {
    schemaVersion: 1,
    repository: `${snapshot.repository.owner}/${snapshot.repository.repo}`,
    pullRequest: input.record.pullRequest,
    committedHead: input.record.headOid,
    reviewedHead: input.record.headOid,
    gatedHead: input.record.headOid,
  };
  const finalize = adapters.delivery ?? (
    (request) => finalizeHead(request, { repositoryRoot: snapshot.checkout.root })
  );
  const delivery = finalize(deliveryRequest);
  if (
    delivery?.canMarkDelivered !== true
    || delivery.headOid !== input.record.headOid
    || delivery.liveEvidence?.baseRefName !== config.baseBranch
    || !HASH_RE.test(
      delivery.liveEvidence?.provenance?.evidenceFingerprint ?? '',
    )
  ) {
    throw new Error(
      `exact-head delivery is not green (${delivery?.state ?? 'unknown'}/${delivery?.code ?? 'unknown'})`,
    );
  }
  const record = createPremergeRecord({
    ...structuredClone(input.record),
    review: {
      summaryHash: sha256(review),
    },
    gate: {
      summaryHash: sha256(gate),
    },
    ci: {
      evidenceHash: delivery.liveEvidence.provenance.evidenceFingerprint,
    },
  });
  const create = adapters.createPremerge ?? (
    (value) => createPremergeRecordComment(
      value,
      snapshot.repository,
      { repositoryRoot: snapshot.checkout.root },
    )
  );
  const premerge = create(record, snapshot.repository);
  if (
    premerge?.observation?.verified !== true
    || premerge.attestation?.premergeRecordId !== record.recordId
  ) {
    throw new Error('premerge record creation postcondition is unverified');
  }
  const bind = adapters.bindLifecycle ?? (
    (value, created) => bindPremergeLifecycle(
      value,
      created,
      snapshot.repository,
      { repositoryRoot: snapshot.checkout.root },
    )
  );
  const binding = bind(record, premerge, snapshot.repository);
  if (binding?.verified !== true) {
    throw new Error('lifecycle premerge binding postcondition is unverified');
  }
  const beforeEffects = (adapters.snapshot ?? snapshotExecutionRepository)(
    snapshot.checkout.root,
  );
  if (!samePublicationSnapshot(snapshot, beforeEffects)) {
    throw new Error('checkout or publication repository changed before terminal effects');
  }
  const fetchState = adapters.terminalState ?? fetchTerminalState;
  let state = fetchState(
    snapshot.repository,
    input.record.issue,
    input.record.pullRequest,
  );
  if (!terminalStateMatches(state, input)) {
    throw new Error('terminal state does not match the exact record identity');
  }
  if (state.draft) {
    (adapters.markReady ?? markPullRequestReady)(snapshot.repository, state);
    state = fetchState(
      snapshot.repository,
      input.record.issue,
      input.record.pullRequest,
    );
    if (!terminalStateMatches(state, input) || state.draft) {
      throw new Error('ready transition changed the terminal record identity');
    }
  }
  const effectDelivery = finalize(deliveryRequest);
  if (
    effectDelivery?.canMarkDelivered !== true
    || effectDelivery.headOid !== record.headOid
    || effectDelivery.liveEvidence?.provenance?.evidenceFingerprint
      !== record.ci.evidenceHash
  ) {
    throw new Error('exact-head delivery evidence changed before terminal effects');
  }
  state = fetchState(
    snapshot.repository,
    input.record.issue,
    input.record.pullRequest,
  );
  if (!terminalStateMatches(state, input) || state.draft) {
    throw new Error('terminal state changed before delivered mutation');
  }
  if (
    !state.labels.includes('loop-delivered')
    || state.labels.includes('loop-started')
    || state.labels.some((label) => label.startsWith('loop:'))
  ) {
    (adapters.markDelivered ?? markIssueDelivered)(snapshot.repository, state);
  }
  state = fetchState(
    snapshot.repository,
    input.record.issue,
    input.record.pullRequest,
  );
  if (!terminalStateMatches(state, input) || !deliveredState(state)) {
    throw new Error('ready and delivered terminal postconditions are unverified');
  }
  const finalDelivery = finalize(deliveryRequest);
  if (
    finalDelivery?.canMarkDelivered !== true
    || finalDelivery.headOid !== record.headOid
    || finalDelivery.liveEvidence?.provenance?.evidenceFingerprint
      !== record.ci.evidenceHash
  ) {
    throw new Error('terminal delivery evidence changed after finalization');
  }
  const observe = adapters.observePremerge ?? (
    (attestation) => observePremergeRecord(
      attestation,
      snapshot.repository,
      { repositoryRoot: snapshot.checkout.root },
    )
  );
  const observed = observe(premerge.attestation, snapshot.repository);
  if (
    observed?.authorized !== true
    || observed?.observation?.verified !== true
  ) {
    throw new Error('premerge record is not verified after terminal mutation');
  }
  const completedSnapshot = (adapters.snapshot ?? snapshotExecutionRepository)(
    snapshot.checkout.root,
  );
  if (!samePublicationSnapshot(snapshot, completedSnapshot)) {
    throw new Error('checkout or publication repository changed during terminal effects');
  }
  return {
    schemaVersion: 2,
    mode: config.merge.policy,
    headOid: record.headOid,
    ready: true,
    delivered: true,
    statuses: Object.fromEntries(
      Object.entries(statuses).map(([name, status]) => [name, status.context]),
    ),
    record,
    premerge: {
      created: premerge.created,
      commentId: premerge.observation.commentId ?? null,
    },
    delivery: {
      state: finalDelivery.state,
      code: finalDelivery.code,
      evidenceFingerprint: record.ci.evidenceHash,
    },
  };
}

// Pure arg validation — closed context enum + lowercase 40-hex SHA. Exported for --self-test.
export function validateArgs(ctx, sha) {
  if (!CONTEXTS.has(ctx)) return { ok: false, error: `context must be one of: ${[...CONTEXTS].join(', ')}` };
  if (!SHA_RE.test(sha ?? '')) return { ok: false, error: 'second arg must be the full 40-hex (lowercase) gated SHA (git rev-parse HEAD)' };
  return { ok: true };
}

function exactObjectKeys(value, keys) {
  return (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
  );
}

function validCommentId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 255;
}

export function validateTerminalInput(input) {
  const errors = [];
  if (!exactObjectKeys(input, [
    'schemaVersion',
    'record',
    'reviewEvidence',
  ])) {
    return ['terminal input must contain only the closed v1 fields'];
  }
  if (input.schemaVersion !== 1) errors.push('schemaVersion: expected 1');
  const record = input.record;
  if (!exactObjectKeys(record, [
    'issue',
    'pullRequest',
    'headOid',
    'run',
    'plan',
    'lifecycle',
  ])) {
    errors.push('record: invalid fields');
  } else {
    if (!Number.isSafeInteger(record.issue) || record.issue < 1) {
      errors.push('record.issue: expected a positive safe integer');
    }
    if (!Number.isSafeInteger(record.pullRequest) || record.pullRequest < 1) {
      errors.push('record.pullRequest: expected a positive safe integer');
    }
    if (!SHA_RE.test(record.headOid ?? '')) {
      errors.push('record.headOid: expected a lowercase commit OID');
    }
    if (
      !exactObjectKeys(record.run, ['intentHash', 'receiptFingerprint'])
      || !HASH_RE.test(record.run?.intentHash ?? '')
      || !HASH_RE.test(record.run?.receiptFingerprint ?? '')
    ) {
      errors.push('record.run: invalid exact-head run binding');
    }
    if (
      !exactObjectKeys(record.plan, ['commentId', 'contentHash'])
      || !validCommentId(record.plan?.commentId)
      || !HASH_RE.test(record.plan?.contentHash ?? '')
    ) {
      errors.push('record.plan: invalid frozen-plan binding');
    }
    if (
      !exactObjectKeys(record.lifecycle, ['commentId'])
      || !validCommentId(record.lifecycle?.commentId)
    ) {
      errors.push('record.lifecycle: invalid lifecycle comment binding');
    }
  }
  if (
    input.reviewEvidence === null
    || typeof input.reviewEvidence !== 'object'
    || Array.isArray(input.reviewEvidence)
  ) {
    errors.push('reviewEvidence: expected an object');
  }
  return errors;
}

export function parseTerminalCommandArgs(args) {
  if (args[0] !== 'terminal-finalize') return null;
  const parsed = {
    command: 'terminal-finalize',
    requestFile: null,
    reviewEvidenceFile: null,
    error: null,
  };
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    const pathField = new Map([
      ['--request-file', 'requestFile'],
      ['--review-evidence-file', 'reviewEvidenceFile'],
    ]).get(flag);
    if (
      pathField
      && parsed[pathField] === null
      && typeof value === 'string'
      && value.length > 0
      && !value.startsWith('-')
    ) {
      parsed[pathField] = value;
      index += 1;
      continue;
    }
    parsed.error = `unknown, duplicate, or incomplete terminal option: ${flag ?? 'missing'}`;
    return parsed;
  }
  if (parsed.requestFile === null || parsed.reviewEvidenceFile === null) {
    parsed.error =
      'terminal-finalize requires --request-file and --review-evidence-file';
  }
  return parsed;
}

const PREMERGE_COMMANDS = new Set([
  'premerge-create',
  'premerge-observe',
  'premerge-append',
]);

export function parsePremergeCommandArgs(args) {
  const [command, ...rest] = args;
  if (!PREMERGE_COMMANDS.has(command)) return null;
  const parsed = {
    command,
    recordFile: null,
    attestationFile: null,
    mergeOid: null,
    expectedBodyHash: null,
    error: null,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (
      flag === '--record-file'
      && parsed.recordFile === null
      && value
      && !value.startsWith('-')
    ) {
      parsed.recordFile = value;
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
      flag === '--merge-oid'
      && parsed.mergeOid === null
      && SHA_RE.test(value ?? '')
    ) {
      parsed.mergeOid = value;
      index += 1;
      continue;
    }
    if (
      flag === '--expected-body-hash'
      && parsed.expectedBodyHash === null
      && /^[0-9a-f]{64}$/.test(value ?? '')
    ) {
      parsed.expectedBodyHash = value;
      index += 1;
      continue;
    }
    parsed.error = `unknown, duplicate, or incomplete premerge option: ${flag ?? 'missing'}`;
    return parsed;
  }
  if (
    command === 'premerge-create'
    && (
      parsed.recordFile === null
      || parsed.attestationFile !== null
      || parsed.mergeOid !== null
      || parsed.expectedBodyHash !== null
    )
  ) {
    parsed.error = 'premerge-create requires only --record-file';
  }
  if (
    command === 'premerge-observe'
    && (
      parsed.attestationFile === null
      || parsed.recordFile !== null
      || parsed.mergeOid !== null
      || parsed.expectedBodyHash !== null
    )
  ) {
    parsed.error = 'premerge-observe requires only --attestation-file';
  }
  if (
    command === 'premerge-append'
    && (
      parsed.attestationFile === null
      || parsed.mergeOid === null
      || parsed.expectedBodyHash === null
      || parsed.recordFile !== null
    )
  ) {
    parsed.error =
      'premerge-append requires --attestation-file, --merge-oid, and --expected-body-hash';
  }
  return parsed;
}

export function parseArgs(args) {
  const [ctx, sha, ...rest] = args;
  const parsed = {
    ctx,
    sha,
    reviewEvidenceFile: null,
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
    parsed.error = `unknown, duplicate, or incomplete option: ${flag ?? 'missing'}`;
    return parsed;
  }
  if (ctx === 'review') {
    if (parsed.reviewEvidenceFile === null) {
      parsed.error =
        'review requires --review-evidence-file and forbids other evidence files';
    }
  } else if (ctx === 'gate') {
    if (parsed.reviewEvidenceFile !== null) {
      parsed.error = 'gate executes cfg.gate.command and forbids caller-authored evidence';
    }
  }
  return parsed;
}

function selfTest() {
  const cases = [
    [['gate', 'a'.repeat(40)], true],
    [['review', 'a'.repeat(40)], true],
    [['ownership', 'a'.repeat(40)], false], // retired CheckRun-era context
    [['policy', 'a'.repeat(40)], false], // retired CheckRun-era context
    [['human-authorization', 'a'.repeat(40)], false], // retired CheckRun-era context
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
  const statusPayload = buildCommitStatus('gate', 'a'.repeat(40), 'f'.repeat(64));
  if (
    statusPayload.context !== 'agentic/gate'
    || statusPayload.state !== 'success'
    || statusPayload.description !== `autoloop gate verified · sha256:${'f'.repeat(16)}`
    || statusPayload.description.length > 140
  ) {
    console.error('FAIL verdict publishes as a success commit status');
  } else passed += 1;
  let invalidDescriptionRejected = false;
  try {
    buildStatusDescription('deploy', 'f'.repeat(64));
  } catch {
    invalidDescriptionRejected = true;
  }
  try {
    invalidDescriptionRejected = invalidDescriptionRejected
      && (buildStatusDescription('gate', 'not-a-hash') && false);
  } catch {
    // second refusal confirmed
  }
  if (invalidDescriptionRejected) {
    passed += 1;
  } else {
    console.error('FAIL status descriptions require closed context and SHA-256 hash');
  }
  const statusHead = 'a'.repeat(40);
  const statusItems = [
    { context: 'agentic/gate', state: 'success', description: 'autoloop gate verified · sha256:0000000000000000' },
    { context: 'ci/test', state: 'success', description: null },
  ];
  let statusReads = 0;
  const stableStatuses = fetchPublicationStatuses(
    { host: 'github.com', owner: 'autoloop', repo: 'fixture' },
    statusHead,
    () => {
      statusReads += 1;
      return { sha: statusHead, statuses: structuredClone(statusItems) };
    },
  );
  if (
    stableStatuses.complete
    && stableStatuses.items.length === statusItems.length
    && statusReads === 2
    && stableStatuses.items.every((status) => typeof status.description === 'string')
  ) {
    passed += 1;
  } else {
    console.error('FAIL publication statuses use explicit complete stable reads');
  }
  let statusMutationCalls = 0;
  let changedStatusesRejected = false;
  try {
    fetchPublicationStatuses(
      { host: 'github.com', owner: 'autoloop', repo: 'fixture' },
      statusHead,
      () => {
        statusMutationCalls += 1;
        return {
          sha: statusHead,
          statuses: [{
            ...statusItems[0],
            state: statusMutationCalls > 1 ? 'pending' : 'success',
          }],
        };
      },
    );
  } catch {
    changedStatusesRejected = true;
  }
  if (changedStatusesRejected && statusMutationCalls === 2) {
    passed += 1;
  } else {
    console.error('FAIL changing publication status evidence is rejected');
  }
  let wrongHeadStatusesRejected = false;
  try {
    fetchPublicationStatuses(
      { host: 'github.com', owner: 'autoloop', repo: 'fixture' },
      statusHead,
      () => ({ sha: 'b'.repeat(40), statuses: [] }),
    );
  } catch {
    wrongHeadStatusesRejected = true;
  }
  if (wrongHeadStatusesRejected) {
    passed += 1;
  } else {
    console.error('FAIL status evidence for the wrong head is rejected');
  }
  const parsed = parseArgs([
    'review',
    'a'.repeat(40),
    '--review-evidence-file',
    '/tmp/review.json',
  ]);
  if (
    !parsed.error
    && parsed.reviewEvidenceFile === '/tmp/review.json'
  ) {
    passed += 1;
  } else {
    console.error('FAIL closed CLI options parse');
  }
  const inline = parseArgs(['gate', 'a'.repeat(40), 'untrusted inline summary']);
  if (inline.error) passed += 1;
  else console.error('FAIL inline summary is rejected');
  if (parseArgs([
    'review',
    'a'.repeat(40),
    '--expect-app-id',
    '42',
  ]).error) passed += 1;
  else console.error('FAIL retired --expect-app-id is rejected');
  if (parseArgs([
    'ownership',
    'a'.repeat(40),
    '--attestation-file',
    '/tmp/ownership.json',
  ]).error) passed += 1;
  else console.error('FAIL retired attestation contexts are rejected');
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
  const planBody = 'frozen reviewed plan';
  const reviewSummaryValue =
    `Authenticated review convergence: REVIEW_CLEAN; round 2; receipt ${'2'.repeat(64)}.`;
  const gateAttestation = {
    kind: 'gate',
    v: 1,
    headOid: 'a'.repeat(40),
    commandHash: '4'.repeat(64),
    configHash: '5'.repeat(64),
    repositoryFingerprint: '6'.repeat(64),
  };
  const gateSummaryValue = serializeAttestation(gateAttestation);
  const lifecycleMarker = {
    v: 1,
    issue: 7,
    issueBodyHash: 'b'.repeat(64),
    planHash: sha256(planBody),
    branch: 'feat/gh-7-publisher',
    plannedBaseOid: 'e'.repeat(40),
    selector: 'native',
    runIntentHash: '1'.repeat(64),
    intentSource: 'invocation',
    mergePolicy: 'manual',
    phase: 'ready-head',
    claimCommit: 'c'.repeat(40),
    pr: 12,
    headOid: 'a'.repeat(40),
  };
  const lifecycleBody = serializeLifecycleMarker(lifecycleMarker);
  const policyStatuses = {
    complete: true,
    items: [
      {
        context: 'agentic/gate',
        state: 'success',
        description: buildStatusDescription('gate', sha256(gateSummaryValue)),
      },
      {
        context: 'agentic/review',
        state: 'success',
        description: buildStatusDescription('review', sha256(reviewSummaryValue)),
      },
      { context: 'ci/test', state: 'success', description: 'CI passed' },
    ],
  };
  const deliveryEvidence = {
    schemaVersion: 2,
    source: 'github-rest',
    repository: 'autoloop/fixture',
    pullRequest: lifecycleMarker.pr,
    remoteHead: lifecycleMarker.headOid,
    baseRefName: 'main',
    checks: [{
      id: 103,
      name: 'ci/test',
      headOid: lifecycleMarker.headOid,
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
    }],
    statuses: policyStatuses.items,
  };
  const delivery = {
    state: 'delivered',
    code: 'CI_GREEN',
    canMarkDelivered: true,
    headOid: lifecycleMarker.headOid,
    liveEvidence: {
      ...deliveryEvidence,
      provenance: {
        schemaVersion: 2,
        source: 'github-rest',
        repository: deliveryEvidence.repository,
        pullRequest: deliveryEvidence.pullRequest,
        evidenceFingerprint: sha256(stableJson(deliveryEvidence)),
      },
    },
  };
  const premerge = createPremergeRecord({
    issue: lifecycleMarker.issue,
    pullRequest: lifecycleMarker.pr,
    headOid: lifecycleMarker.headOid,
    run: {
      intentHash: lifecycleMarker.runIntentHash,
      receiptFingerprint: '2'.repeat(64),
    },
    plan: {
      commentId: 'IC_plan',
      contentHash: sha256(planBody),
    },
    review: {
      summaryHash: sha256(reviewSummaryValue),
    },
    gate: {
      summaryHash: sha256(gateSummaryValue),
    },
    ci: {
      evidenceHash: delivery.liveEvidence.provenance.evidenceFingerprint,
    },
    lifecycle: {
      commentId: 'IC_lifecycle',
      identityHash: lifecycleIdentityHash(lifecycleMarker),
    },
  });
  const policy = {
    kind: 'policy',
    v: 1,
    headOid: premerge.headOid,
    issue: premerge.issue,
    pullRequest: premerge.pullRequest,
    delivered: true,
    premergeRecordId: premerge.recordId,
    premergeRecordHash: premergeRecordHash(premerge),
    premergeRecordAuthor: 'autoloop[bot]',
  };
  const policyComment = {
    id: 'IC_premerge',
    author: { login: policy.premergeRecordAuthor },
    body: serializePremergeRecord(premerge),
    lastEditedAt: null,
    neverEdited: true,
  };
  const policyLive = {
    complete: true,
    loopAuthor: policy.premergeRecordAuthor,
    issue: { number: policy.issue, id: 'I_issue' },
    pullRequest: {
      number: policy.pullRequest,
      headOid: policy.headOid,
      headRefName: `feat/gh-${policy.issue}-publisher`,
      body: `Closes #${policy.issue}`,
      merged: false,
      mergeOid: null,
    },
    comments: {
      complete: true,
      items: [
        {
          id: premerge.plan.commentId,
          author: { login: policy.premergeRecordAuthor },
          body: planBody,
          lastEditedAt: null,
          neverEdited: true,
        },
        {
          id: premerge.lifecycle.commentId,
          author: { login: policy.premergeRecordAuthor },
          body: lifecycleBody,
          lastEditedAt: null,
          neverEdited: true,
        },
        policyComment,
      ],
    },
    statuses: policyStatuses,
    delivery,
  };
  if (authorizePolicyPublication(policy, policyLive).authorized) {
    passed += 1;
  } else {
    console.error('FAIL policy publication proves the complete durable premerge comment');
  }
  if (!authorizePolicyPublication(policy, {
    ...policyLive,
    loopAuthor: 'maintainer',
  }).authorized) {
    passed += 1;
  } else {
    console.error('FAIL policy publication rejects a non-dedicated live author');
  }
  if (!authorizePolicyPublication(policy, {
    ...policyLive,
    comments: { complete: false, items: [policyComment] },
  }).authorized) {
    passed += 1;
  } else {
    console.error('FAIL policy publication rejects incomplete comment pagination');
  }
  const remappedLifecycleComments = (change) => ({
    complete: true,
    items: policyLive.comments.items.map((comment) =>
      (comment.id === premerge.lifecycle.commentId
        ? change(comment)
        : comment)),
  });
  const editedLifecycleAuthorization = authorizePolicyPublication(policy, {
    ...policyLive,
    comments: remappedLifecycleComments((comment) => ({
      ...comment,
      lastEditedAt: '2026-07-25T00:00:00Z',
      neverEdited: false,
    })),
  });
  if (
    !editedLifecycleAuthorization.authorized
    && editedLifecycleAuthorization.code === 'PREMERGE_COMMENT_COMPONENT_MISMATCH'
  ) {
    passed += 1;
  } else {
    console.error('FAIL an unanchored edited lifecycle marker cannot authorize publication');
  }
  const missingEditEvidence = authorizePolicyPublication(policy, {
    ...policyLive,
    comments: remappedLifecycleComments(({
      neverEdited: ignoredNeverEdited,
      lastEditedAt: ignoredLastEditedAt,
      ...comment
    }) => comment),
  });
  if (
    !missingEditEvidence.authorized
    && missingEditEvidence.code === 'PREMERGE_COMPONENTS_INCOMPLETE'
  ) {
    passed += 1;
  } else {
    console.error('FAIL absent lifecycle edit evidence is incomplete, not unedited');
  }
  if (!authorizePolicyPublication(policy, {
    ...policyLive,
    statuses: {
      complete: true,
      items: policyLive.statuses.items.filter((status) =>
        status.context !== 'agentic/review'),
    },
  }).authorized) {
    passed += 1;
  } else {
    console.error('FAIL canonical wrapper cannot authorize an absent verdict status');
  }
  if (!authorizePolicyPublication(policy, {
    ...policyLive,
    statuses: {
      complete: true,
      items: policyLive.statuses.items.map((status) =>
        (status.context === 'agentic/review'
          ? { ...status, description: buildStatusDescription('review', 'd'.repeat(64)) }
          : status)),
    },
  }).authorized) {
    passed += 1;
  } else {
    console.error('FAIL a verdict status with a foreign summary hash cannot authorize');
  }
  const parsedCreate = parsePremergeCommandArgs([
    'premerge-create',
    '--record-file',
    '/tmp/premerge.json',
  ]);
  const parsedObserve = parsePremergeCommandArgs([
    'premerge-observe',
    '--attestation-file',
    '/tmp/policy.json',
  ]);
  const parsedAppend = parsePremergeCommandArgs([
    'premerge-append',
    '--attestation-file',
    '/tmp/policy.json',
    '--merge-oid',
    '9'.repeat(40),
    '--expected-body-hash',
    premergeRecordHash(premerge),
  ]);
  if (
    !parsedCreate.error
    && !parsedObserve.error
    && !parsedAppend.error
    && parsePremergeCommandArgs([
      'premerge-append',
      '--attestation-file',
      '/tmp/policy.json',
    ]).error
  ) {
    passed += 1;
  } else {
    console.error('FAIL closed premerge operation CLI parses');
  }
  let operationalComments = policyLive.comments.items.filter((comment) =>
    comment.id !== policyComment.id);
  let operationalMerged = false;
  let operationalMergeOid = null;
  let operationalCommentSequence = 0;
  const operationalAdapters = {
    publisherLogin: () => policy.premergeRecordAuthor,
    fetchEvidence: () => ({
      ...policyLive,
      pullRequest: {
        ...policyLive.pullRequest,
        merged: operationalMerged,
        mergeOid: operationalMergeOid,
      },
      comments: { complete: true, items: structuredClone(operationalComments) },
    }),
    addComment: (_repository, _issueId, body) => {
      operationalCommentSequence += 1;
      const comment = {
        id: `IC_premerge_operational_${operationalCommentSequence}`,
        author: { login: policy.premergeRecordAuthor },
        body,
        neverEdited: true,
      };
      operationalComments.push(comment);
      return comment;
    },
  };
  const operationalRepository = {
    host: 'github.com',
    owner: 'autoloop',
    repo: 'fixture',
  };
  const createdRecord = createPremergeRecordComment(
    premerge,
    operationalRepository,
    operationalAdapters,
  );
  if (
    createdRecord.created
    && createdRecord.observation.verified
    && operationalComments.length === policyLive.comments.items.length
  ) {
    passed += 1;
  } else {
    console.error('FAIL premerge create posts and refetches the exact record');
  }
  const repeatedCreate = createPremergeRecordComment(
    premerge,
    operationalRepository,
    operationalAdapters,
  );
  if (!repeatedCreate.created && repeatedCreate.observation.verified) {
    passed += 1;
  } else {
    console.error('FAIL premerge create retry is idempotent');
  }
  const lifecycleBinding = bindPremergeLifecycle(
    premerge,
    createdRecord,
    operationalRepository,
    {
      observe: (attestation, repository) => observePremergeRecord(
        attestation,
        repository,
        operationalAdapters,
      ),
      append: operationalAdapters.addComment,
    },
  );
  if (
    lifecycleBinding.verified
    && lifecycleBinding.marker.premergeRecord === premerge.recordId
    && lifecycleBinding.marker.phase === 'premerge-record'
  ) {
    passed += 1;
  } else {
    console.error('FAIL premerge creation binds and reads back the lifecycle marker');
  }
  operationalMerged = true;
  operationalMergeOid = '9'.repeat(40);
  const appendedOutcome = appendPremergeTerminalOutcome(
    createdRecord.attestation,
    operationalMergeOid,
    operationalRepository,
    {
      ...operationalAdapters,
      expectedCommentBodyHash: premergeRecordHash(premerge),
    },
  );
  const repeatedOutcome = appendPremergeTerminalOutcome(
    createdRecord.attestation,
    operationalMergeOid,
    operationalRepository,
    {
      ...operationalAdapters,
      expectedCommentBodyHash: premergeRecordHash(premerge),
    },
  );
  if (
    appendedOutcome.changed
    && !repeatedOutcome.changed
    && repeatedOutcome.outcome.mergeOid === operationalMergeOid
  ) {
    passed += 1;
  } else {
    console.error('FAIL terminal append is live-proven and idempotent');
  }
  let policyPageCalls = 0;
  const fetchedPolicy = fetchPolicyPublicationEvidence(
    { host: 'github.com', owner: 'autoloop', repo: 'fixture' },
    policy,
    {
      graphql: (_repository, _query, variables) => {
        policyPageCalls += 1;
        const second = variables.cursor === 'cursor-1';
        return {
          viewer: { login: policy.premergeRecordAuthor },
          repository: {
            issue: {
              id: 'I_issue',
              number: policy.issue,
              comments: {
                totalCount: policyLive.comments.items.length,
                nodes: second
                  ? policyLive.comments.items.slice(1)
                  : policyLive.comments.items.slice(0, 1),
                pageInfo: {
                  hasNextPage: !second,
                  endCursor: second ? null : 'cursor-1',
                },
              },
            },
            pullRequest: {
              number: policy.pullRequest,
              headRefOid: policy.headOid,
              headRefName: `feat/gh-${policy.issue}-publisher`,
              body: `Closes #${policy.issue}`,
              merged: false,
              mergeCommit: null,
            },
          },
        };
      },
      statuses: () => policyStatuses,
      delivery: () => delivery,
    },
  );
  if (
    policyPageCalls === 2
    && fetchedPolicy.comments.items.length === policyLive.comments.items.length
    && authorizePolicyPublication(policy, fetchedPolicy).authorized
  ) {
    passed += 1;
  } else {
    console.error('FAIL policy publication hydrates every linked-issue comment page');
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
        reviewEvidenceFingerprint: 'c'.repeat(64),
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
        reviewEvidenceFingerprint: null,
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
    }, 'a'.repeat(40));
    if (
      apiArgs[1] === '--hostname'
      && apiArgs[2] === 'github.example.com'
      && apiArgs[3] === `repos/autoloop/review-fixture/statuses/${'a'.repeat(40)}`
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
    }, 'a'.repeat(40));
    console.error('FAIL publication rejects an invalid repository target');
  } catch {
    passed += 1;
  }
  const gateConfig = {
    version: '0.26.0',
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
  const ensuredStatuses = [];
  let ensurePublications = 0;
  const ensureOverrides = {
    fetchStatuses: () => ({
      complete: true,
      items: structuredClone(ensuredStatuses),
    }),
    publish: (_repository, _headOid, payload) => {
      ensurePublications += 1;
      ensuredStatuses.push(structuredClone(payload));
      return structuredClone(payload);
    },
  };
  const reviewHash = sha256(reviewSummaryValue);
  const ensured = ensurePublishedStatus(
    'review',
    premerge.headOid,
    reviewHash,
    operationalRepository,
    ensureOverrides,
  );
  const reused = ensurePublishedStatus(
    'review',
    premerge.headOid,
    reviewHash,
    operationalRepository,
    ensureOverrides,
  );
  let conflictingStatusRejected = false;
  try {
    ensurePublishedStatus(
      'review',
      premerge.headOid,
      'd'.repeat(64),
      operationalRepository,
      ensureOverrides,
    );
  } catch {
    conflictingStatusRejected = true;
  }
  const timeoutStatuses = [];
  const recoveredAfterTimeout = ensurePublishedStatus(
    'gate',
    premerge.headOid,
    sha256(gateSummaryValue),
    operationalRepository,
    {
      fetchStatuses: () => ({
        complete: true,
        items: structuredClone(timeoutStatuses),
      }),
      publish: (_repository, _headOid, payload) => {
        timeoutStatuses.push(structuredClone(payload));
        throw new Error('simulated response loss');
      },
    },
  );
  if (
    ensured.context === 'agentic/review'
    && reused.description === ensured.description
    && ensurePublications === 1
    && conflictingStatusRejected
    && recoveredAfterTimeout.context === 'agentic/gate'
  ) {
    passed += 1;
  } else {
    console.error('FAIL exact-head status publication is idempotent and conflict-safe');
  }
  const stateLabels = Array.from(
    { length: 101 },
    (_, index) => ({ id: index + 1, name: `label-${index + 1}` }),
  );
  let terminalStateReads = 0;
  const stableTerminalState = fetchTerminalState(
    operationalRepository,
    premerge.issue,
    premerge.pullRequest,
    (_repository, endpoint) => {
      terminalStateReads += 1;
      if (endpoint.includes('/labels?')) {
        return endpoint.endsWith('page=1')
          ? stateLabels.slice(0, 100)
          : stateLabels.slice(100);
      }
      if (endpoint.includes('/pulls/')) {
        return {
          number: premerge.pullRequest,
          node_id: 'PR_node',
          state: 'open',
          merged: false,
          draft: true,
          head: { sha: premerge.headOid },
        };
      }
      return {
        number: premerge.issue,
        node_id: 'I_node',
        state: 'open',
      };
    },
  );
  if (
    stableTerminalState.complete
    && stableTerminalState.labels.length === stateLabels.length
    && stableTerminalState.draft
    && terminalStateReads === 8
  ) {
    passed += 1;
  } else {
    console.error('FAIL terminal readiness and issue labels use complete stable reads');
  }
  const terminalArgs = parseTerminalCommandArgs([
    'terminal-finalize',
    '--request-file',
    '/tmp/terminal.json',
    '--review-evidence-file',
    '/tmp/review.json',
  ]);
  if (
    terminalArgs
    && !terminalArgs.error
    && terminalArgs.requestFile === '/tmp/terminal.json'
    && terminalArgs.reviewEvidenceFile === '/tmp/review.json'
    && parseTerminalCommandArgs([
      'terminal-finalize',
      '--request-file',
      '/tmp/terminal.json',
      '--review-evidence-file',
      '/tmp/review.json',
      '--ownership-attestation-file',
      '/tmp/ownership.json',
    ]).error
    && parseTerminalCommandArgs([
      'terminal-finalize',
      '--request-file',
      '/tmp/terminal.json',
      '--review-evidence-file',
      '/tmp/review.json',
      '--expect-app-id',
      '42',
    ]).error
  ) {
    passed += 1;
  } else {
    console.error('FAIL closed terminal-finalize CLI parses and rejects retired flags');
  }
  const terminalInput = {
    schemaVersion: 1,
    record: {
      issue: premerge.issue,
      pullRequest: premerge.pullRequest,
      headOid: premerge.headOid,
      run: structuredClone(premerge.run),
      plan: structuredClone(premerge.plan),
      lifecycle: { commentId: premerge.lifecycle.commentId },
    },
    reviewEvidence: { round: 2 },
  };
  if (
    validateTerminalInput(terminalInput).length === 0
    && validateTerminalInput({ ...terminalInput, delivered: true }).length > 0
    && validateTerminalInput({
      ...terminalInput,
      record: {
        ...terminalInput.record,
        lifecycle: structuredClone(premerge.lifecycle),
      },
    }).length > 0
  ) {
    passed += 1;
  } else {
    console.error('FAIL terminal-finalize input is closed and typed');
  }
  const {
    headOid: ignoredLifecycleHead,
    ...draftLifecycleMarker
  } = lifecycleMarker;
  draftLifecycleMarker.epoch = 1;
  draftLifecycleMarker.phase = 'draft-pr';
  draftLifecycleMarker.planCommentId = premerge.plan.commentId;
  const lifecycleRootBody = serializeLifecycleMarker(draftLifecycleMarker);
  const lifecycleComments = [{
    id: premerge.lifecycle.commentId,
    body: lifecycleRootBody,
    neverEdited: true,
  }];
  let lifecycleAppends = 0;
  const lifecycleObserve = () => {
    const chain = resolveLifecycleCommentChain(
      lifecycleComments,
      premerge.lifecycle.commentId,
    );
    return {
      complete: true,
      issue: premerge.issue,
      issueId: 'I_issue',
      pullRequest: premerge.pullRequest,
      headOid: premerge.headOid,
      rootCommentId: chain.root.id,
      sequence: chain.sequence,
      comment: {
        id: chain.tip.id,
        body: chain.tip.body,
        bodyHash: sha256(chain.tip.body),
      },
    };
  };
  const finalizedLifecycle = bindFinalizedLifecycleHead(
    terminalInput.record,
    operationalRepository,
    {
      observe: lifecycleObserve,
      append: (_repository, binding, body) => {
        if (binding.comment.bodyHash !== sha256(lifecycleRootBody)) {
          throw new Error('test lifecycle predecessor mismatch');
        }
        lifecycleAppends += 1;
        lifecycleComments.push({
          id: `IC_lifecycle_successor_${lifecycleAppends}`,
          body,
          neverEdited: true,
        });
      },
    },
  );
  const replayedLifecycle = bindFinalizedLifecycleHead(
    terminalInput.record,
    operationalRepository,
    {
      observe: lifecycleObserve,
      append: () => {
        lifecycleAppends += 1;
      },
    },
  );
  if (
    finalizedLifecycle.verified
    && finalizedLifecycle.marker.headOid === premerge.headOid
    && HASH_RE.test(finalizedLifecycle.identityHash)
    && replayedLifecycle.identityHash === finalizedLifecycle.identityHash
    && lifecycleAppends === 1
  ) {
    passed += 1;
  } else {
    console.error('FAIL terminal finalization binds a draft lifecycle head once');
  }
  let lifecycleRaceRejected = false;
  let raceReads = 0;
  try {
    bindFinalizedLifecycleHead(
      terminalInput.record,
      operationalRepository,
      {
        observe: () => {
          raceReads += 1;
          const body = raceReads === 1
            ? serializeLifecycleMarker(draftLifecycleMarker)
            : `${serializeLifecycleMarker(draftLifecycleMarker)}\nchanged`;
          return {
            complete: true,
            issue: premerge.issue,
            issueId: 'I_issue',
            pullRequest: premerge.pullRequest,
            headOid: premerge.headOid,
            rootCommentId: premerge.lifecycle.commentId,
            sequence: raceReads - 1,
            comment: {
              id: raceReads === 1
                ? premerge.lifecycle.commentId
                : 'IC_concurrent_successor',
              body,
              bodyHash: sha256(body),
            },
          };
        },
        append: () => {
          throw new Error('raced lifecycle must not append');
        },
      },
    );
  } catch {
    lifecycleRaceRejected = true;
  }
  if (lifecycleRaceRejected && raceReads === 2) {
    passed += 1;
  } else {
    console.error('FAIL lifecycle head binding rejects a CAS race');
  }
  const terminalStatuses = new Map([
    ['review', {
      state: 'success',
      context: 'agentic/review',
      description: buildStatusDescription('review', sha256(reviewSummaryValue)),
    }],
    ['gate', {
      state: 'success',
      context: 'agentic/gate',
      description: buildStatusDescription('gate', sha256(gateSummaryValue)),
    }],
  ]);
  const terminalSequence = [];
  let terminalDraft = true;
  let terminalLabels = ['loop-ready', 'loop-started', 'loop:09-gate'];
  const terminalAdapters = {
    snapshot: () => structuredClone(gateSnapshot),
    config: () => structuredClone(gateConfig),
    bindFinalizedLifecycle: () => {
      terminalSequence.push('head-bind');
      return {
        verified: true,
        marker: structuredClone(lifecycleMarker),
        identityHash: premerge.lifecycle.identityHash,
      };
    },
    review: () => reviewSummaryValue,
    gate: () => gateSummaryValue,
    ensureStatus: (context) => {
      terminalSequence.push(`status:${context}`);
      return structuredClone(terminalStatuses.get(context));
    },
    delivery: () => {
      terminalSequence.push('delivery');
      return structuredClone(delivery);
    },
    createPremerge: (record) => {
      terminalSequence.push('premerge');
      return {
        created: true,
        attestation: policyAttestationForRecord(record, 'autoloop[bot]'),
        observation: { verified: true },
      };
    },
    bindLifecycle: () => {
      terminalSequence.push('bind');
      return { verified: true };
    },
    terminalState: () => {
      terminalSequence.push('terminal-read');
      return {
        complete: true,
        issue: premerge.issue,
        pullRequest: premerge.pullRequest,
        headOid: premerge.headOid,
        draft: terminalDraft,
        labels: [...terminalLabels],
      };
    },
    markReady: () => {
      terminalSequence.push('ready');
      terminalDraft = false;
    },
    markDelivered: () => {
      terminalSequence.push('delivered');
      terminalLabels = ['loop-ready', 'loop-delivered'];
    },
    observePremerge: () => {
      terminalSequence.push('observe');
      return { authorized: true, observation: { verified: true } };
    },
  };
  const terminalResult = finalizeTerminalDelivery(terminalInput, {
    repositoryRoot: '/repo',
    adapters: terminalAdapters,
  });
  if (
    terminalResult.ready === true
    && terminalResult.delivered === true
    && terminalResult.record.recordId === premerge.recordId
    && terminalSequence.join(',') === [
      'head-bind',
      'status:review',
      'status:gate',
      'delivery',
      'premerge',
      'bind',
      'terminal-read',
      'ready',
      'terminal-read',
      'delivery',
      'terminal-read',
      'delivered',
      'terminal-read',
      'delivery',
      'observe',
    ].join(',')
  ) {
    passed += 1;
  } else {
    console.error('FAIL draft manual delivery reaches one read-back terminal finalizer');
  }
  let racedHead = premerge.headOid;
  let racedDraft = true;
  let racedDelivered = false;
  let readinessRaceRejected = false;
  try {
    finalizeTerminalDelivery(terminalInput, {
      repositoryRoot: '/repo',
      adapters: {
        ...terminalAdapters,
        terminalState: () => ({
          complete: true,
          issue: premerge.issue,
          pullRequest: premerge.pullRequest,
          headOid: racedHead,
          draft: racedDraft,
          labels: ['loop-ready', 'loop-started'],
        }),
        markReady: () => {
          racedDraft = false;
          racedHead = 'b'.repeat(40);
        },
        markDelivered: () => {
          racedDelivered = true;
        },
      },
    });
  } catch {
    readinessRaceRejected = true;
  }
  if (readinessRaceRejected && !racedDelivered) {
    passed += 1;
  } else {
    console.error('FAIL a head change after readiness cannot reach delivered mutation');
  }
  let deliveryReads = 0;
  let staleReadyDelivered = false;
  let staleReadyRejected = false;
  try {
    finalizeTerminalDelivery(terminalInput, {
      repositoryRoot: '/repo',
      adapters: {
        ...terminalAdapters,
        terminalState: () => ({
          complete: true,
          issue: premerge.issue,
          pullRequest: premerge.pullRequest,
          headOid: premerge.headOid,
          draft: false,
          labels: ['loop-ready', 'loop-started'],
        }),
        delivery: () => {
          deliveryReads += 1;
          return deliveryReads === 1
            ? structuredClone(delivery)
            : {
                ...structuredClone(delivery),
                state: 'awaiting-ci',
                code: 'CI_PENDING',
                canMarkDelivered: false,
              };
        },
        markDelivered: () => {
          staleReadyDelivered = true;
        },
      },
    });
  } catch {
    staleReadyRejected = true;
  }
  if (staleReadyRejected && !staleReadyDelivered && deliveryReads === 2) {
    passed += 1;
  } else {
    console.error('FAIL a ready PR revalidates CI before delivered mutation');
  }
  let blockedTerminalRejected = false;
  try {
    finalizeTerminalDelivery(terminalInput, {
      repositoryRoot: '/repo',
      adapters: {
        ...terminalAdapters,
        terminalState: () => ({
          complete: true,
          issue: premerge.issue,
          pullRequest: premerge.pullRequest,
          headOid: premerge.headOid,
          draft: false,
          labels: ['loop-ready', 'loop-blocked', 'loop-delivered'],
        }),
      },
    });
  } catch {
    blockedTerminalRejected = true;
  }
  if (blockedTerminalRejected) {
    passed += 1;
  } else {
    console.error('FAIL a hard-blocked linked issue cannot become terminal');
  }
  const nonManualSequence = [];
  const nonManualCommonAdapters = {
    ...terminalAdapters,
    config: () => ({
      ...structuredClone(gateConfig),
      merge: { policy: 'ratified' },
    }),
    createPremerge: (record) => ({
      created: false,
      attestation: policyAttestationForRecord(record, 'autoloop[bot]'),
      observation: { verified: true },
    }),
    bindLifecycle: () => ({ verified: true }),
    terminalState: () => ({
      complete: true,
      issue: premerge.issue,
      pullRequest: premerge.pullRequest,
      headOid: premerge.headOid,
      draft: false,
      labels: ['loop-ready', 'loop-delivered'],
    }),
    delivery: () => structuredClone(delivery),
    observePremerge: () => ({
      authorized: true,
      observation: { verified: true },
    }),
  };
  // Non-manual without both recorded solo acknowledgements is a typed refusal:
  // the v0.40 multi-actor unattended mode is retired, not degraded into.
  let unacknowledgedNonManualRejected = false;
  try {
    finalizeTerminalDelivery(structuredClone(terminalInput), {
      repositoryRoot: '/repo',
      adapters: nonManualCommonAdapters,
    });
  } catch (error) {
    unacknowledgedNonManualRejected = error.message.includes('solo-only');
  }
  if (unacknowledgedNonManualRejected) {
    passed += 1;
  } else {
    console.error('FAIL non-manual finalization without solo acknowledgements refuses typed');
  }
  let partiallyAcknowledgedRejected = false;
  try {
    finalizeTerminalDelivery(structuredClone(terminalInput), {
      repositoryRoot: '/repo',
      adapters: {
        ...nonManualCommonAdapters,
        config: () => ({
          ...structuredClone(gateConfig),
          merge: {
            policy: 'ratified',
            unverifiedInvocationAcknowledged: true,
          },
        }),
      },
    });
  } catch (error) {
    partiallyAcknowledgedRejected = error.message.includes('solo-only');
  }
  if (partiallyAcknowledgedRejected) {
    passed += 1;
  } else {
    console.error('FAIL one acknowledgement alone cannot unlock non-manual finalization');
  }
  const soloResult = finalizeTerminalDelivery(structuredClone(terminalInput), {
    repositoryRoot: '/repo',
    adapters: {
      ...nonManualCommonAdapters,
      config: () => ({
        ...structuredClone(gateConfig),
        merge: {
          policy: 'ratified',
          unverifiedInvocationAcknowledged: true,
          soloOperatorAcknowledged: true,
        },
      }),
      ensureStatus: (context) => {
        nonManualSequence.push(`status:${context}`);
        return structuredClone(terminalStatuses.get(context));
      },
      markReady: () => nonManualSequence.push('ready'),
      markDelivered: () => nonManualSequence.push('delivered'),
    },
  });
  if (
    soloResult.ready === true
    && soloResult.delivered === true
    && soloResult.mode === 'ratified'
    && soloResult.statuses.review === 'agentic/review'
    && soloResult.statuses.gate === 'agentic/gate'
    && nonManualSequence.join(',') === 'status:review,status:gate'
  ) {
    passed += 1;
  } else {
    console.error('FAIL acknowledged solo delivery posts exactly the two verdict statuses');
  }
  const total = cases.length + 45;
  console.log(passed === total ? `self-test OK (${passed} cases)` : `self-test FAILED (${passed}/${total})`);
  return passed === total;
}

function runPremergeCli(parsed) {
  if (parsed.error) throw new Error(parsed.error);
  const snapshot = snapshotExecutionRepository(process.cwd());
  if (snapshot.checkout.clean !== true) {
    throw new Error('premerge operations require a clean live checkout');
  }
  if (parsed.command === 'premerge-create') {
    const record = JSON.parse(
      readBoundedNoFollow(
        parsed.recordFile,
        MAX_AUXILIARY_EVIDENCE_BYTES,
      ).toString('utf8'),
    );
    serializePremergeRecord(record);
    if (record.headOid !== snapshot.checkout.headOid) {
      throw new Error('premerge record is not bound to the live checkout head');
    }
    return createPremergeRecordComment(record, snapshot.repository);
  }
  const attestation = JSON.parse(
    readBoundedNoFollow(
      parsed.attestationFile,
      MAX_AUXILIARY_EVIDENCE_BYTES,
    ).toString('utf8'),
  );
  const errors = validateAttestation(attestation, {
    kind: 'policy',
    headOid: snapshot.checkout.headOid,
  });
  if (errors.length > 0) throw new Error(errors.join('; '));
  if (parsed.command === 'premerge-observe') {
    const observed = observePremergeRecord(attestation, snapshot.repository);
    return {
      attestation,
      observation: observed.observation,
      components: observed.components,
      lifecycleFacts: observed.lifecycleFacts,
    };
  }
  return appendPremergeTerminalOutcome(
    attestation,
    parsed.mergeOid,
    snapshot.repository,
    { expectedCommentBodyHash: parsed.expectedBodyHash },
  );
}

function runTerminalCli(parsed) {
  if (parsed.error) throw new Error(parsed.error);
  const request = JSON.parse(
    readBoundedNoFollow(
      parsed.requestFile,
      MAX_AUXILIARY_EVIDENCE_BYTES,
    ).toString('utf8'),
  );
  if (!exactObjectKeys(request, ['schemaVersion', 'record'])) {
    throw new Error('terminal request file must contain only schemaVersion and record');
  }
  const reviewEvidence = JSON.parse(
    readBoundedNoFollow(
      parsed.reviewEvidenceFile,
      MAX_REVIEW_EVIDENCE_BYTES,
    ).toString('utf8'),
  );
  return finalizeTerminalDelivery(
    {
      ...request,
      reviewEvidence,
    },
    { repositoryRoot: process.cwd() },
  );
}

function main() {
  const terminal = parseTerminalCommandArgs(process.argv.slice(2));
  if (terminal) {
    try {
      console.log(JSON.stringify(runTerminalCli(terminal)));
      return;
    } catch (error) {
      console.error(`publish-verdict: ${error.message}`);
      process.exit(1);
    }
  }
  const premerge = parsePremergeCommandArgs(process.argv.slice(2));
  if (premerge) {
    try {
      const result = runPremergeCli(premerge);
      console.log(JSON.stringify(result));
      return;
    } catch (error) {
      console.error(`publish-verdict: ${error.message}`);
      process.exit(1);
    }
  }
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
  try {
    const summaryHash = sha256(summary);
    const status = ensurePublishedStatus(
      parsed.ctx,
      parsed.sha,
      summaryHash,
      publicationSnapshot.repository,
    );
    console.log(
      `posted ${status.context}=success on ${parsed.sha.slice(0, 12)}`
      + ` · sha256:${summaryHash.slice(0, 16)}`,
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
