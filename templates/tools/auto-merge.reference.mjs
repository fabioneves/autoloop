#!/usr/bin/env node
// ============================================================================
// GENERIC RATIFIED AUTO-MERGE GATE — engine is generic; the REPO CONFIG block
// below is filled by autoloop:setup from your repo's facts.
//
// The policy ENGINE (independently fetched, SHA-bound evidence; AND-gate;
// kill-switch; CAS merge + confirmation) is battle-tested production code.
// The self-test fixtures DERIVE from the config block, so `--self-test` stays
// meaningful for any filled config — run it after every config change.
//
// RATIFICATION: this file only carries policy authority once a HUMAN has merged
// the PR that vendors it into the repo (normally the autoloop:setup scaffold
// PR — which may set `merge.policy: "ratified"` in the same PR, since nothing
// takes effect until that human merge). When merge policy is `ratified`, the
// scaffold MUST land via a PR — a direct commit would skip the ratifying merge.
// The tool's own tools/** path stays protected so it can never authorize
// changes to itself.
// ============================================================================
// Ratified auto-merge gate for the dev loop.
//
// This is a ratified-policy model: the human merge of the PR that introduced this
// tool grants the policy authority, not the loop that runs it. The policy is a pure
// AND-gate over independently fetched, SHA-bound GitHub evidence. The tool can only
// satisfy that policy or refuse; its own tools/** path is protected and can never be
// authorized by this file.
//
// Usage:
//   node tools/agentic/auto-merge.mjs <prNumber> [--dry-run]
//   node tools/agentic/auto-merge.mjs --self-test
//
// Exit 0 = merged, would-merge in dry-run, or all self-tests passed.
// Exit 1 = normal refusal, ambiguous merge outcome, or self-test failure.
// Exit 2 = usage error.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseAttestation,
  serializeAttestation,
} from './attestation-contract.mjs';
import { parseLoopClaim } from './claim-contract.mjs';
import { matchMergeProtected } from './lane-contract.mjs';
import {
  REQUIRED_ATTESTATIONS,
  authorizeMerge,
} from './merge-authorization-contract.mjs';

// ── REPO CONFIG — filled by autoloop:setup; the vendored copy in your repo is the policy ──
export const REPOSITORY = { owner: 'your-org', name: 'your-repo' }; // setup: from `gh repo view`
export const BASE_BRANCH = 'main'; // setup: the loop's base branch
// Required GitHub-Actions check-run names. Setup fills this from the repo's detected
// CI workflows, confirmed with the user.
// EMPTY means the repo has no CI: auto-merges then rest on the loop's own SHA-bound
// verdicts alone — setup must warn loudly and recommend `manual` in that case.
export const REQUIRED_CI_CHECKS = [];
// Path B allowlist (globs): the reversible class that may auto-merge WITHOUT a human
// risk label. Docs-only is the safe generic default; widen only by explicit user choice.
// (Protected families below still veto — a reversible glob can never expose a protected path.)
export const REVERSIBLE_PATHS = ['docs/**'];
// Repo crown jewels beyond the generic structural families below. Setup mirrors
// STATE's escalate-list here (auth, secrets, schema, payments, external contracts, …).
export const EXTRA_PROTECTED_PATHS = [];
// Authorization mode:
//   'classified' — only the reversible class auto-merges: Path A (human risk label)
//                  or Path B (REVERSIBLE_PATHS allowlist + ≤20 files / ≤400 lines).
//   'all-green'  — every loop PR auto-merges when ALL evidence is green (verdicts,
//                  CI, clean merge state, no unresolved threads) — EXCEPT the floor
//                  that never auto-merges in any mode: protected paths (structural +
//                  extra) and hard-block labels (human:authorize, do-not-merge, …).
//                  The mode widens the CLASS, never the floor. Without CI it rests
//                  on the loop's own verdicts alone — setup must refuse to write it
//                  unless the user explicitly accepts that in so many words.
export const AUTOMERGE_MODE = 'classified';
export const LOOP_LOGIN = 'autoloop[bot]';
export const TRUSTED_HUMAN_LOGINS = ['maintainer'];
export const TRUSTED_AUTOMATION_APP_IDS = [1];
export const TRUSTED_AUTHORIZATION_APP_IDS = [2];
export const REQUIRED_CI_CHECK_APPS = {};
export const REQUIRED_APPROVING_REVIEW_COUNT = 1;
export const REQUIRE_CODE_OWNER_REVIEWS = false;
export const BASE_FRESHNESS_STRATEGY = 'direct-strict';
// ── end repo config — everything below is the generic engine ──

export const REQUIRED_VERDICTS = ['agentic/gate', 'agentic/review'];
export const SAFE_LABELS = ['risk:pure-deletion', 'risk:mechanical-refactor'];

// Minimal glob → regex: '**' = any path segment(s), '*' = within a segment.
export function globToRe(glob) {
  const re = glob
    .split(/(\*\*|\*)/)
    .map((part) => {
      if (part === '**') return '.*';
      if (part === '*') return '[^/]*';
      return part.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${re}$`, 'i');
}

const REVERSIBLE_RES = REVERSIBLE_PATHS.map(globToRe);

const REPO_SLUG = `${REPOSITORY.owner}/${REPOSITORY.name}`;
const HEAD_SHA = 'a'.repeat(40);
const LOOP_ISSUE = 7;
const ISSUE_BODY_HASH = 'b'.repeat(64);
const FROZEN_PLAN_HASH = 'c'.repeat(64);
const GH_API_HEADERS = [
  '-H',
  'Accept: application/vnd.github+json',
  '-H',
  'X-GitHub-Api-Version: 2026-03-10',
];

function requiredCheckContracts() {
  return [
    ...REQUIRED_ATTESTATIONS.map((name) => ({
      name,
      appIds: [...TRUSTED_AUTOMATION_APP_IDS],
    })),
    ...REQUIRED_CI_CHECKS.map((name) => ({
      name,
      appIds: [...(REQUIRED_CI_CHECK_APPS[name] ?? [])],
    })),
  ];
}

const CORE_QUERY = `
  query($owner:String!, $name:String!, $number:Int!) {
    repository(owner:$owner, name:$name) {
      pullRequest(number:$number) {
        state
        isDraft
        baseRefName
        headRefName
        headRefOid
        body
        headRepository { name owner { login } }
        labels(first:100) {
          nodes { name }
          pageInfo { hasNextPage endCursor }
        }
        changedFiles
        additions
        deletions
        reviewDecision
        reviewRequests(first:100) {
          nodes {
            requestedReviewer {
              __typename
              ... on User { login }
              ... on Team { slug name }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
        mergeStateStatus
      }
    }
  }
`;

const REVIEW_REQUESTS_QUERY = `
  query($owner:String!, $name:String!, $number:Int!, $cursor:String) {
    repository(owner:$owner, name:$name) {
      pullRequest(number:$number) {
        reviewRequests(first:100, after:$cursor) {
          nodes {
            requestedReviewer {
              __typename
              ... on User { login }
              ... on Team { slug name }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

const LABELS_QUERY = `
  query($owner:String!, $name:String!, $number:Int!, $cursor:String) {
    repository(owner:$owner, name:$name) {
      pullRequest(number:$number) {
        labels(first:100, after:$cursor) {
          nodes { name }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

const THREADS_QUERY = `
  query($owner:String!, $name:String!, $number:Int!, $cursor:String) {
    repository(owner:$owner, name:$name) {
      pullRequest(number:$number) {
        reviewThreads(first:100, after:$cursor) {
          nodes {
            isResolved
            isOutdated
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

const ISSUE_QUERY = `
  query($owner:String!,$name:String!,$number:Int!){
    repository(owner:$owner,name:$name){
      issue(number:$number){
        id
        number
        state
        body
        createdAt
        lastEditedAt
        labels(first:100){
          nodes{name}
          pageInfo{hasNextPage endCursor}
        }
        comments(first:100){
          nodes{
            id
            author{login}
            body
          }
          pageInfo{hasNextPage endCursor}
        }
      }
    }
  }
`;

const ISSUE_LABELS_QUERY = `
  query($id:ID!,$cursor:String){
    node(id:$id){
      ... on Issue{
        labels(first:100,after:$cursor){
          nodes{name}
          pageInfo{hasNextPage endCursor}
        }
      }
    }
  }
`;

const ISSUE_COMMENTS_QUERY = `
  query($id:ID!,$cursor:String){
    node(id:$id){
      ... on Issue{
        comments(first:100,after:$cursor){
          nodes{
            id
            author{login}
            body
          }
          pageInfo{hasNextPage endCursor}
        }
      }
    }
  }
`;

const DEPENDENCY_QUERY = `
  query($owner:String!,$name:String!,$number:Int!){
    repository(owner:$owner,name:$name){
      issue(number:$number){
        number
        state
      }
    }
  }
`;

function upper(value) {
  return String(value ?? '').toUpperCase();
}

function errorMessage(error) {
  const parts = [error?.message, error?.stderr, error?.stdout].filter(Boolean);
  return (parts.join(' — ').replace(/\s+/g, ' ').trim() || 'unknown error').slice(0, 500);
}

function ghJson(args, input) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new Error('gh arguments must be a string array');
  }
  const output = execFileSync('gh', args, {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 15000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(output);
}

function ghApiArgs(endpoint, extra = []) {
  return ['api', endpoint, ...GH_API_HEADERS, ...extra];
}

function ghGraphql(query, variables) {
  const response = ghJson(
    ghApiArgs('graphql', ['--input', '-']),
    JSON.stringify({ query, variables }),
  );
  if (response.errors?.length) {
    throw new Error(response.errors.map((item) => item.message).join('; '));
  }
  if (!response.data) throw new Error('GraphQL response did not contain data');
  return response.data;
}

function parseIncludedResponse(output) {
  const boundary = String(output).search(/\r?\n\r?\n/);
  if (boundary < 0) throw new Error('GitHub response omitted HTTP headers');
  const separator = /^\r?\n\r?\n/.exec(String(output).slice(boundary))?.[0];
  if (!separator) throw new Error('GitHub response header boundary is invalid');
  const headerText = String(output).slice(0, boundary);
  const bodyText = String(output).slice(boundary + separator.length);
  const headers = new Map();
  const lines = headerText.split(/\r?\n/);
  if (!/^HTTP\/\S+\s+2\d\d\b/.test(lines.shift() ?? '')) {
    throw new Error('GitHub response status is not successful');
  }
  for (const line of lines) {
    const match = /^([^:]+):\s*(.*)$/.exec(line);
    if (match) headers.set(match[1].toLowerCase(), match[2]);
  }
  return { data: JSON.parse(bodyText), link: headers.get('link') ?? null };
}

function nextLink(link) {
  if (link === null) return null;
  if (typeof link !== 'string' || link.length === 0) {
    throw new Error('GitHub Link header is malformed');
  }
  const next = [];
  for (const match of link.matchAll(/<([^>]+)>\s*;\s*rel="([^"]+)"/g)) {
    if (match[2].split(/\s+/).includes('next')) next.push(match[1]);
  }
  if (next.length > 1 || (/\brel="?next\b/i.test(link) && next.length !== 1)) {
    throw new Error('GitHub Link header has an ambiguous next page');
  }
  if (next.length === 0) return null;
  let url;
  try {
    url = new URL(next[0], 'https://api.github.com');
  } catch {
    throw new Error('GitHub next-page URL is invalid');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('GitHub next-page URL is unsafe');
  }
  return url.href;
}

function fetchRestPage(endpoint) {
  const args = ghApiArgs(endpoint);
  const output = execFileSync(
    'gh',
    ['api', '--include', ...args.slice(1)],
    {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return parseIncludedResponse(output);
}

export function ghPaginated(endpoint, fetchPage = fetchRestPage) {
  const pages = [];
  const seen = new Set();
  let next = endpoint;
  for (let page = 1; page <= 50; page += 1) {
    if (typeof next !== 'string' || next.length === 0 || seen.has(next)) {
      throw new Error('GitHub pagination repeated or omitted its next page');
    }
    seen.add(next);
    const response = fetchPage(next);
    const data = response?.data;
    pages.push(data);
    const items = Array.isArray(data)
      ? data
      : Array.isArray(data?.statuses)
        ? data.statuses
        : Array.isArray(data?.check_runs)
          ? data.check_runs
          : null;
    if (!items) throw new Error('paginated page had an unrecognized shape');
    next = nextLink(response?.link ?? null);
    if (next === null) return pages;
  }
  throw new Error('pagination exceeded 50 pages — refusing rather than truncating');
}

function pageInfo(connection, label) {
  if (!connection?.pageInfo) throw new Error(`${label} response had no pageInfo`);
  return connection.pageInfo;
}

function reviewerName(reviewer) {
  if (!reviewer) return 'unknown reviewer';
  if (reviewer.__typename === 'Team') return `team:${reviewer.slug ?? reviewer.name ?? 'unknown'}`;
  return `user:${reviewer.login ?? 'unknown'}`;
}

function fetchPullRequestCore(number) {
  const data = ghGraphql(CORE_QUERY, {
    owner: REPOSITORY.owner,
    name: REPOSITORY.name,
    number: Number(number),
  });
  const pr = data.repository?.pullRequest;
  if (!pr) throw new Error(`PR #${number} was not found`);

  const labels = (pr.labels?.nodes ?? []).map((label) => label.name).filter(Boolean);
  const reviewRequests = (pr.reviewRequests?.nodes ?? []).map((request) => ({
    reviewer: reviewerName(request.requestedReviewer),
  }));

  let labelsPage = pageInfo(pr.labels, 'labels');
  while (labelsPage.hasNextPage) {
    if (!labelsPage.endCursor) throw new Error('labels pagination had no endCursor');
    const next = ghGraphql(LABELS_QUERY, {
      owner: REPOSITORY.owner,
      name: REPOSITORY.name,
      number: Number(number),
      cursor: labelsPage.endCursor,
    }).repository?.pullRequest?.labels;
    if (!next) throw new Error('labels pagination returned no connection');
    labels.push(...(next.nodes ?? []).map((label) => label.name).filter(Boolean));
    labelsPage = pageInfo(next, 'labels');
  }

  let requestsPage = pageInfo(pr.reviewRequests, 'review requests');
  while (requestsPage.hasNextPage) {
    if (!requestsPage.endCursor) throw new Error('review request pagination had no endCursor');
    const next = ghGraphql(REVIEW_REQUESTS_QUERY, {
      owner: REPOSITORY.owner,
      name: REPOSITORY.name,
      number: Number(number),
      cursor: requestsPage.endCursor,
    }).repository?.pullRequest?.reviewRequests;
    if (!next) throw new Error('review request pagination returned no connection');
    reviewRequests.push(...(next.nodes ?? []).map((request) => ({
      reviewer: reviewerName(request.requestedReviewer),
    })));
    requestsPage = pageInfo(next, 'review requests');
  }

  return {
    coreComplete: true,
    state: upper(pr.state),
    isDraft: pr.isDraft,
    baseRefName: pr.baseRefName,
    headRefName: pr.headRefName,
    headRefOid: pr.headRefOid,
    body: pr.body,
    headRepository: {
      owner: pr.headRepository?.owner?.login,
      name: pr.headRepository?.name,
    },
    labels,
    changedFiles: pr.changedFiles,
    additions: pr.additions,
    deletions: pr.deletions,
    reviewDecision: upper(pr.reviewDecision),
    reviewRequests,
    reviewRequestsComplete: true,
    mergeStateStatus: upper(pr.mergeStateStatus),
  };
}

function fetchChangedFiles(number) {
  const pages = ghPaginated(`repos/${REPO_SLUG}/pulls/${number}/files?per_page=100`);
  const entries = [];
  for (const page of pages) {
    if (!Array.isArray(page)) throw new Error('changed-files page was not an array');
    entries.push(...page);
  }
  return {
    fileEntries: entries.map((file) => ({
      filename: file.filename,
      previous_filename: file.previous_filename ?? null,
    })),
    filePaginationComplete: true,
  };
}

function fetchReviewThreads(number) {
  const nodes = [];
  let cursor = null;
  while (true) {
    const connection = ghGraphql(THREADS_QUERY, {
      owner: REPOSITORY.owner,
      name: REPOSITORY.name,
      number: Number(number),
      cursor,
    }).repository?.pullRequest?.reviewThreads;
    if (!connection) throw new Error('review thread response returned no connection');
    for (const thread of connection.nodes ?? []) {
      nodes.push({
        isResolved: thread.isResolved === true,
        // Thread-level field: PullRequestReviewComment has no isOutdated (verified live).
        latestIsOutdated: thread.isOutdated === true,
      });
    }
    const info = pageInfo(connection, 'review threads');
    if (!info.hasNextPage) break;
    if (!info.endCursor) throw new Error('review thread pagination had no endCursor');
    cursor = info.endCursor;
  }
  return { reviewThreads: nodes, threadPaginationComplete: true };
}

/**
 * Flatten combined-status pages into per-status entries stamped with the page's sha.
 * The REST combined-status ITEMS carry no `sha` of their own — only the page object
 * does — so decide()'s SHA-binding check would empty out every real run without this
 * stamp. The page sha is the API's own answer for which commit these statuses
 * decorate; a page reporting a different sha than the one requested fails the fetch.
 */
export function collectCombinedStatuses(pages, headRefOid) {
  const statuses = [];
  for (const page of pages) {
    if (!page || !Array.isArray(page.statuses)) throw new Error('commit status page had no statuses array');
    if (page.sha !== headRefOid) {
      throw new Error(`commit status page is for ${page.sha ?? 'unknown'}, not the fetched head ${headRefOid}`);
    }
    statuses.push(...page.statuses.map((status) => ({ ...status, sha: page.sha })));
  }
  const total = pages[0]?.total_count;
  if (!Number.isInteger(total) || total !== statuses.length) {
    throw new Error(`commit status pagination count mismatch (reported ${total}, fetched ${statuses.length})`);
  }
  return statuses;
}

function fetchRollup(headRefOid) {
  const result = { statuses: [], checkRuns: [], rollupComplete: true, fetchReasons: [] };

  try {
    const pages = ghPaginated(`repos/${REPO_SLUG}/commits/${headRefOid}/status?per_page=100`);
    result.statuses = collectCombinedStatuses(pages, headRefOid);
  } catch (error) {
    result.rollupComplete = false;
    result.fetchReasons.push(`commit statuses fetch failed: ${errorMessage(error)}`);
  }

  try {
    const pages = ghPaginated(`repos/${REPO_SLUG}/commits/${headRefOid}/check-runs?per_page=100`);
    const checkRuns = [];
    for (const page of pages) {
      if (!page || !Array.isArray(page.check_runs)) throw new Error('check-run page had no check_runs array');
      checkRuns.push(...page.check_runs);
    }
    const total = pages[0]?.total_count;
    if (!Number.isInteger(total) || total !== checkRuns.length) {
      throw new Error(`check-run pagination count mismatch (reported ${total}, fetched ${checkRuns.length})`);
    }
    result.checkRuns = checkRuns;
  } catch (error) {
    result.rollupComplete = false;
    result.fetchReasons.push(`check-run fetch failed: ${errorMessage(error)}`);
  }

  return result;
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function blockedBy(body) {
  const section = /##\s*Blocked by([\s\S]*?)(\n##\s|$)/i.exec(body ?? '');
  if (!section) return [];
  return [...new Set([...section[1].matchAll(/#([1-9]\d*)/g)].map((match) => Number(match[1])))];
}

function latestLabelEvent(events, label) {
  return (events ?? []).filter(
    (event) =>
      new Set(['labeled', 'unlabeled']).has(event?.event)
      && event?.label?.name === label,
  ).at(-1) ?? null;
}

export function deriveLiveIssueEvidence(input) {
  const issue = input?.issue;
  const timeline = input?.timeline;
  const comments = input?.comments;
  const dependencies = input?.dependencies;
  const permission = input?.loopReadyPermission;
  const ownership = input?.ownership;
  const labels = Array.isArray(issue?.labels) ? issue.labels : [];
  const expectedDependencies = blockedBy(issue?.body);
  const dependencyItems = Array.isArray(dependencies?.items)
    ? dependencies.items.map((dependency) => ({
      number: dependency?.number,
      state: upper(dependency?.state),
    }))
    : [];
  const dependencyNumbers = dependencyItems.map((dependency) => dependency.number);
  const dependenciesComplete =
    dependencies?.complete === true
    && dependencyItems.every((dependency) =>
      Number.isSafeInteger(dependency.number) && dependency.number > 0)
    && new Set(dependencyNumbers).size === dependencyNumbers.length
    && expectedDependencies.length === dependencyItems.length
    && expectedDependencies.every((number) => dependencyNumbers.includes(number));
  const readyEvent = latestLabelEvent(timeline?.items, 'loop-ready');
  const loopReadyComplete =
    timeline?.complete === true
    && readyEvent?.event === 'labeled'
    && Number.isSafeInteger(readyEvent?.id)
    && readyEvent.id > 0
    && typeof readyEvent?.actor?.login === 'string'
    && typeof readyEvent?.created_at === 'string'
    && permission?.complete === true
    && permission.login === readyEvent.actor.login
    && typeof permission.roleName === 'string';
  const commentMatches = Array.isArray(comments?.items)
    ? comments.items.filter((comment) => comment?.id === ownership?.frozenPlanCommentId)
    : [];
  const planComment = commentMatches.length === 1 ? commentMatches[0] : null;
  const frozenPlanCommentVerified =
    comments?.complete === true
    && ownership?.complete === true
    && typeof ownership?.frozenPlanCommentId === 'string'
    && ownership.frozenPlanCommentId.length > 0
    && ownership?.frozenPlanAuthor === input?.loopLogin
    && planComment?.author?.login === ownership.frozenPlanAuthor
    && typeof planComment?.body === 'string'
    && planComment.body.length > 0
    && sha256(planComment.body) === ownership.frozenPlanHash;
  const hardLabels = new Set([
    'human:authorize',
    'human:legal',
    'automerge:halt',
    'do-not-merge',
    'loop-blocked',
    'needs-human',
    'needs-dependency',
    'needs-secret',
  ]);
  const complete =
    issue?.complete === true
    && issue?.labelsComplete === true
    && Number.isSafeInteger(issue?.number)
    && issue.number > 0
    && typeof issue?.body === 'string'
    && Array.isArray(issue?.labels)
    && timeline?.complete === true
    && comments?.complete === true
    && dependenciesComplete;
  return {
    linkedIssue: {
      complete,
      number: issue?.number ?? null,
      state: upper(issue?.state),
      labels,
      bodyHash: sha256(issue?.body ?? ''),
      createdAt: issue?.createdAt ?? null,
      lastEditedAt: issue?.lastEditedAt ?? null,
      blocked: labels.some((label) => hardLabels.has(label)),
      dependenciesClear:
        dependenciesComplete
        && dependencyItems.every((dependency) => dependency.state === 'CLOSED'),
      dependenciesComplete,
      dependencies: dependencyItems,
      loopReady: {
        complete: loopReadyComplete,
        eventId: readyEvent?.id ?? null,
        actor: readyEvent?.actor?.login ?? null,
        labeledAt: readyEvent?.created_at ?? null,
        roleName: permission?.roleName ?? null,
      },
    },
    ownership: ownership
      ? {
        ...ownership,
        frozenPlanPresent: planComment !== null,
        frozenPlanCommentVerified,
      }
      : null,
  };
}

export function deriveLiveAuthorizationEvidence(input) {
  const authorization = input?.authorization;
  if (!authorization) return null;
  const timelineItems = Array.isArray(input?.timeline?.items) ? input.timeline.items : [];
  const event = latestLabelEvent(timelineItems, authorization.label);
  const eventIndex = timelineItems.lastIndexOf(event);
  const headMutationEvents = new Set([
    'committed',
    'head_ref_deleted',
    'head_ref_force_pushed',
    'head_ref_restored',
  ]);
  const headEventIndex = timelineItems.findLastIndex((item) =>
    headMutationEvents.has(item?.event));
  const headEvent = timelineItems[headEventIndex];
  const observedHeadOid = headEvent?.event === 'committed'
    ? headEvent?.sha
    : headEvent?.commit_id;
  const afterCurrentHead =
    input?.timeline?.complete === true
    && headEventIndex >= 0
    && String(observedHeadOid ?? '').toLowerCase() === String(input?.headOid ?? '').toLowerCase()
    && eventIndex > headEventIndex;
  const permission = input?.permission;
  const eventVerified =
    input?.timeline?.complete === true
    && event?.event === 'labeled'
    && event?.id === authorization.labelEventId
    && event?.created_at === authorization.labeledAt
    && event?.actor?.login === authorization.actor
    && input?.prNumber === authorization.pullRequest
    && input?.headOid === authorization.headOid
    && Array.isArray(input?.labels)
    && input.labels.includes(authorization.label)
    && permission?.complete === true
    && permission.login === authorization.actor
    && new Set(['admin', 'maintain', 'write']).has(permission.roleName);
  return {
    ...authorization,
    complete:
      authorization.complete === true
      && input?.timeline?.complete === true
      && permission?.complete === true,
    eventVerified,
    afterCurrentHead,
    roleName: permission?.roleName ?? null,
  };
}

function emptyActorAllowances(value) {
  if (value === undefined || value === null) return true;
  return (
    value
    && typeof value === 'object'
    && ['users', 'teams', 'apps'].every((key) =>
      value[key] === undefined || (Array.isArray(value[key]) && value[key].length === 0))
  );
}

function addRequiredCheck(checks, context, appId) {
  if (typeof context !== 'string' || context.length === 0) return false;
  if (!Number.isSafeInteger(appId) || appId < 1) return false;
  const appIds = checks.get(context) ?? new Set();
  appIds.add(appId);
  checks.set(context, appIds);
  return true;
}

export function deriveLiveServerPolicy(input) {
  const protectionSection = input?.branchProtection;
  const rulesSection = input?.branchRules;
  const rulesetsSection = input?.rulesets;
  const protection = protectionSection?.value;
  let complete =
    protectionSection?.complete === true
    && rulesSection?.complete === true
    && rulesetsSection?.complete === true
    && protection
    && typeof protection === 'object';
  const statusChecks = protection?.required_status_checks;
  const reviews = protection?.required_pull_request_reviews;
  const requiredChecks = new Map();
  const branchChecks = statusChecks?.checks;
  const branchContexts = statusChecks?.contexts;
  const branchCheckContexts = Array.isArray(branchChecks)
    ? branchChecks.map((check) => check?.context)
    : [];
  if (
    typeof statusChecks?.strict !== 'boolean'
    || !Array.isArray(branchChecks)
    || !Array.isArray(branchContexts)
    || new Set(branchContexts).size !== branchContexts.length
    || new Set(branchCheckContexts).size !== branchCheckContexts.length
    || branchChecks.length !== branchContexts.length
    || branchContexts.some((context) => !branchCheckContexts.includes(context))
  ) {
    complete = false;
  }
  for (const check of branchChecks ?? []) {
    if (
      !branchContexts?.includes(check?.context)
      || !addRequiredCheck(requiredChecks, check?.context, check?.app_id)
    ) {
      complete = false;
    }
  }

  let strict = statusChecks?.strict === true;
  let approvingReviewCount = reviews?.required_approving_review_count;
  let dismissStaleReviews = reviews?.dismiss_stale_reviews;
  let requireLastPushApproval = reviews?.require_last_push_approval;
  let requireCodeOwnerReviews = reviews?.require_code_owner_reviews;
  let conversationResolution = protection?.required_conversation_resolution?.enabled;
  let forcePushesAllowed = protection?.allow_force_pushes?.enabled;
  let deletionsAllowed = protection?.allow_deletions?.enabled;
  let queueRequired = false;
  let actorCanBypass =
    !emptyActorAllowances(reviews?.bypass_pull_request_allowances)
    || protection?.enforce_admins?.enabled !== true;
  if (
    !Number.isInteger(approvingReviewCount)
    || typeof dismissStaleReviews !== 'boolean'
    || typeof requireLastPushApproval !== 'boolean'
    || typeof requireCodeOwnerReviews !== 'boolean'
    || typeof conversationResolution !== 'boolean'
    || typeof forcePushesAllowed !== 'boolean'
    || typeof deletionsAllowed !== 'boolean'
    || typeof protection?.enforce_admins?.enabled !== 'boolean'
  ) {
    complete = false;
  }

  const rules = Array.isArray(rulesSection?.items) ? rulesSection.items : [];
  const rulesets = Array.isArray(rulesetsSection?.items) ? rulesetsSection.items : [];
  const rulesetIds = [...new Set(rules.map((rule) => rule?.ruleset_id))];
  const detailIds = rulesets.map((ruleset) => ruleset?.id);
  let bypassActorsVisible =
    rulesetIds.length === rulesets.length
    && rulesetIds.every((id) => Number.isSafeInteger(id) && detailIds.includes(id));
  if (!bypassActorsVisible) complete = false;
  for (const ruleset of rulesets) {
    if (
      !rulesetIds.includes(ruleset?.id)
      || ruleset?.enforcement !== 'active'
      || !Array.isArray(ruleset?.bypass_actors)
    ) {
      bypassActorsVisible = false;
      complete = false;
      continue;
    }
    if (ruleset.bypass_actors.length > 0) actorCanBypass = true;
  }

  for (const rule of rules) {
    if (typeof rule?.type !== 'string' || !Number.isSafeInteger(rule?.ruleset_id)) {
      complete = false;
      continue;
    }
    const parameters = rule.parameters ?? {};
    if (rule.type === 'required_status_checks') {
      if (
        typeof parameters.strict_required_status_checks_policy !== 'boolean'
        || !Array.isArray(parameters.required_status_checks)
      ) {
        complete = false;
        continue;
      }
      strict ||= parameters.strict_required_status_checks_policy;
      for (const check of parameters.required_status_checks) {
        if (!addRequiredCheck(requiredChecks, check?.context, check?.integration_id)) {
          complete = false;
        }
      }
    } else if (rule.type === 'pull_request') {
      if (
        !Number.isInteger(parameters.required_approving_review_count)
        || typeof parameters.dismiss_stale_reviews_on_push !== 'boolean'
        || typeof parameters.require_last_push_approval !== 'boolean'
        || typeof parameters.require_code_owner_review !== 'boolean'
        || typeof parameters.required_review_thread_resolution !== 'boolean'
      ) {
        complete = false;
        continue;
      }
      approvingReviewCount = Math.max(
        approvingReviewCount,
        parameters.required_approving_review_count,
      );
      dismissStaleReviews ||= parameters.dismiss_stale_reviews_on_push;
      requireLastPushApproval ||= parameters.require_last_push_approval;
      requireCodeOwnerReviews ||= parameters.require_code_owner_review;
      conversationResolution ||= parameters.required_review_thread_resolution;
    } else if (rule.type === 'non_fast_forward') {
      forcePushesAllowed = false;
    } else if (rule.type === 'deletion') {
      deletionsAllowed = false;
    } else if (rule.type === 'merge_queue') {
      queueRequired = true;
    }
  }

  return {
    complete: complete === true,
    source: 'live',
    strategy: 'direct-strict',
    strict,
    enforceAdmins: protection?.enforce_admins?.enabled === true,
    actorCanBypass,
    requiredConversationResolution: conversationResolution,
    requiredApprovingReviewCount: approvingReviewCount,
    requireCodeOwnerReviews,
    dismissStaleReviews,
    requireLastPushApproval,
    forcePushesAllowed,
    deletionsAllowed,
    queueRequired,
    rulesetsComplete:
      rulesSection?.complete === true
      && rulesetsSection?.complete === true
      && rulesetIds.length === rulesets.length,
    bypassActorsVisible,
    requiredChecks: [...requiredChecks.entries()]
      .map(([name, appIds]) => ({ name, appIds: [...appIds].sort((left, right) => left - right) }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

function fetchPermission(login) {
  const data = ghJson(ghApiArgs(
    `repos/${REPO_SLUG}/collaborators/${encodeURIComponent(login)}/permission`,
  ));
  return {
    complete:
      data?.user?.login === login
      && Number.isSafeInteger(data?.user?.id)
      && typeof data?.role_name === 'string',
    login: data?.user?.login ?? null,
    id: data?.user?.id ?? null,
    roleName: data?.role_name ?? null,
  };
}

function fetchIssueRecord(number) {
  const data = ghGraphql(ISSUE_QUERY, {
    owner: REPOSITORY.owner,
    name: REPOSITORY.name,
    number: Number(number),
  });
  const issue = data.repository?.issue;
  if (!issue) throw new Error(`linked #${number} is missing or is not an issue`);
  const labels = (issue.labels?.nodes ?? []).map((label) => label?.name).filter(Boolean);
  const comments = [...(issue.comments?.nodes ?? [])];

  let labelPage = pageInfo(issue.labels, 'linked issue labels');
  while (labelPage.hasNextPage) {
    if (!labelPage.endCursor) throw new Error('linked issue label pagination had no endCursor');
    const next = ghGraphql(ISSUE_LABELS_QUERY, {
      id: issue.id,
      cursor: labelPage.endCursor,
    }).node?.labels;
    if (!next) throw new Error('linked issue label pagination returned no connection');
    labels.push(...(next.nodes ?? []).map((label) => label?.name).filter(Boolean));
    labelPage = pageInfo(next, 'linked issue labels');
  }

  let commentPage = pageInfo(issue.comments, 'linked issue comments');
  while (commentPage.hasNextPage) {
    if (!commentPage.endCursor) throw new Error('linked issue comment pagination had no endCursor');
    const next = ghGraphql(ISSUE_COMMENTS_QUERY, {
      id: issue.id,
      cursor: commentPage.endCursor,
    }).node?.comments;
    if (!next) throw new Error('linked issue comment pagination returned no connection');
    comments.push(...(next.nodes ?? []));
    commentPage = pageInfo(next, 'linked issue comments');
  }

  return {
    issue: {
      complete: true,
      number: issue.number,
      state: upper(issue.state),
      body: issue.body,
      labels,
      labelsComplete: true,
      createdAt: issue.createdAt,
      lastEditedAt: issue.lastEditedAt,
    },
    comments: {
      complete: true,
      items: comments.map((comment) => ({
        id: comment?.id,
        author: { login: comment?.author?.login ?? null },
        body: comment?.body,
      })),
    },
  };
}

function fetchTimeline(number) {
  const pages = ghPaginated(
    `repos/${REPO_SLUG}/issues/${number}/timeline?per_page=100`,
  );
  return {
    complete: true,
    items: pages.flatMap((page) => {
      if (!Array.isArray(page)) throw new Error('issue timeline page was not an array');
      return page;
    }),
  };
}

function fetchDependencies(body) {
  const items = blockedBy(body).map((number) => {
    const issue = ghGraphql(DEPENDENCY_QUERY, {
      owner: REPOSITORY.owner,
      name: REPOSITORY.name,
      number,
    }).repository?.issue;
    if (!issue || issue.number !== number) {
      throw new Error(`dependency #${number} is missing or is not an issue`);
    }
    return { number, state: upper(issue.state) };
  });
  return { complete: true, items };
}

function fetchLinkedIssueEvidence(number, ownership) {
  const record = fetchIssueRecord(number);
  const timeline = fetchTimeline(number);
  const readyEvent = latestLabelEvent(timeline.items, 'loop-ready');
  const loopReadyPermission = readyEvent?.actor?.login
    ? fetchPermission(readyEvent.actor.login)
    : { complete: false, login: null, roleName: null };
  return deriveLiveIssueEvidence({
    ...record,
    timeline,
    dependencies: fetchDependencies(record.issue.body),
    loopReadyPermission,
    ownership,
    loopLogin: LOOP_LOGIN,
  });
}

function fetchLiveAuthorization(number, headOid, labels, authorization) {
  if (!authorization) return null;
  const timeline = fetchTimeline(number);
  const event = latestLabelEvent(timeline.items, authorization.label);
  const permission = event?.actor?.login
    ? fetchPermission(event.actor.login)
    : { complete: false, login: null, roleName: null };
  return deriveLiveAuthorizationEvidence({
    authorization,
    prNumber: number,
    headOid,
    labels,
    timeline,
    permission,
  });
}

function fetchExecutorIdentity() {
  const data = ghJson(ghApiArgs('user'));
  return {
    complete:
      typeof data?.login === 'string'
      && data.login.length > 0
      && Number.isSafeInteger(data?.id)
      && data.id > 0,
    login: data?.login ?? null,
    id: data?.id ?? null,
  };
}

function fetchLiveServerPolicy() {
  const branch = encodeURIComponent(BASE_BRANCH);
  const branchProtection = ghJson(ghApiArgs(
    `repos/${REPO_SLUG}/branches/${branch}/protection`,
  ));
  const rulePages = ghPaginated(
    `repos/${REPO_SLUG}/rules/branches/${branch}?per_page=100`,
  );
  const branchRules = rulePages.flatMap((page) => {
    if (!Array.isArray(page)) throw new Error('active branch rules page was not an array');
    return page;
  });
  const rulesetIds = [...new Set(branchRules.map((rule) => rule?.ruleset_id))];
  if (rulesetIds.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    throw new Error('active branch rule omitted a valid ruleset ID');
  }
  const rulesets = rulesetIds.map((id) =>
    ghJson(ghApiArgs(`repos/${REPO_SLUG}/rulesets/${id}?includes_parents=true`)));
  return deriveLiveServerPolicy({
    branchProtection: { complete: true, value: branchProtection },
    branchRules: { complete: true, items: branchRules },
    rulesets: { complete: true, items: rulesets },
  });
}

function fetchPrCommitOids(number) {
  const pages = ghPaginated(`repos/${REPO_SLUG}/pulls/${number}/commits?per_page=100`);
  const oids = [];
  for (const page of pages) {
    if (!Array.isArray(page)) throw new Error('PR commits page was not an array');
    for (const commit of page) {
      if (/^[0-9a-f]{40}$/i.test(commit?.sha ?? '')) oids.push(commit.sha.toLowerCase());
      else throw new Error('PR commits response contained an invalid OID');
    }
  }
  return oids;
}

function parsedCheckAttestation(checkRuns, name, kind, headOid) {
  const candidates = (checkRuns ?? []).filter((checkRun) =>
    checkRun?.name === name
    && (checkRun.head_sha ?? checkRun.headSha ?? checkRun.headOid) === headOid
    && upper(checkRun.status || (checkRun.conclusion ? 'completed' : '')) === 'COMPLETED'
    && upper(checkRun.conclusion) === 'SUCCESS');
  if (candidates.length !== 1) return null;
  const parsed = parseAttestation(candidates[0]?.output?.summary, { kind, headOid });
  if (!parsed.ok) return null;
  return { value: parsed.attestation, check: normalizedCheckRun(candidates[0]) };
}

export function deriveAttestedEvidence(inputs, commitOids = []) {
  const result = {
    ownership: null,
    lifecycle: null,
    authorization: null,
    executorIdentity: null,
    serverPolicy: null,
    linkedIssue: null,
  };
  const headOid = inputs?.headRefOid;
  if (!/^[0-9a-f]{40}$/i.test(headOid ?? '') || !Array.isArray(inputs?.checkRuns)) return result;
  const claim = parseLoopClaim({ branch: inputs?.headRefName, body: inputs?.body });
  const issue = claim.valid ? claim.issue : null;

  const ownership = parsedCheckAttestation(
    inputs.checkRuns,
    'agentic/ownership',
    'ownership',
    headOid,
  );
  const policy = parsedCheckAttestation(
    inputs.checkRuns,
    'agentic/policy',
    'policy',
    headOid,
  );
  const authorization = parsedCheckAttestation(
    inputs.checkRuns,
    'agentic/human-authorization',
    'human-authorization',
    headOid,
  );

  if (ownership && ownership.value.issue === issue) {
    result.ownership = {
      complete: true,
      issue: ownership.value.issue,
      issueBodyHash: ownership.value.issueBodyHash,
      claimCommitAncestor: commitOids.includes(ownership.value.claimCommitOid),
      frozenPlanPresent: true,
      frozenPlanHash: ownership.value.frozenPlanHash,
      frozenPlanCommentId: ownership.value.frozenPlanCommentId,
      frozenPlanAuthor: ownership.value.frozenPlanAuthor,
      frozenPlanCommentVerified: false,
    };
  }
  if (policy && policy.value.issue === issue) {
    result.lifecycle = {
      complete: true,
      delivered: policy.value.delivered,
      headOid: policy.value.headOid,
      premergeRecord: policy.value.premergeRecord.length > 0,
    };
  }
  if (authorization && authorization.value.pullRequest === inputs?.prNumber) {
    result.authorization = {
      complete: true,
      pullRequest: authorization.value.pullRequest,
      actor: authorization.value.actor,
      headOid: authorization.value.headOid,
      label: authorization.value.label,
      labelEventId: authorization.value.labelEventId,
      labeledAt: authorization.value.labeledAt,
      eventVerified: false,
      roleName: null,
      check: authorization.check,
    };
  }
  return result;
}

function fetchKillSwitch() {
  try {
    const output = execFileSync(
      'gh',
      [
        'issue',
        'list',
        '--repo',
        REPO_SLUG,
        '--label',
        'automerge:halt',
        '--state',
        'open',
        '--json',
        'number',
        '--limit',
        '1000',
      ],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000 },
    );
    const issues = JSON.parse(output);
    if (!Array.isArray(issues)) throw new Error('issue list response was not an array');
    return { killSwitch: { known: true, active: issues.length > 0 } };
  } catch (error) {
    return {
      killSwitch: { known: false, active: false },
      fetchReasons: [`automerge:halt kill-switch query failed: ${errorMessage(error)}`],
    };
  }
}

function emptyInputs() {
  return {
    coreComplete: false,
    state: null,
    isDraft: null,
    baseRefName: null,
    headRefName: null,
    headRefOid: null,
    body: null,
    headRepository: null,
    labels: [],
    changedFiles: null,
    additions: null,
    deletions: null,
    reviewDecision: null,
    reviewRequests: [],
    reviewRequestsComplete: false,
    mergeStateStatus: null,
    fileEntries: [],
    filePaginationComplete: false,
    reviewThreads: [],
    threadPaginationComplete: false,
    statuses: [],
    checkRuns: [],
    rollupComplete: false,
    killSwitch: { known: false, active: false },
    linkedIssue: null,
    ownership: null,
    lifecycle: null,
    authorization: null,
    serverPolicy: null,
    fetchReasons: [],
  };
}

function fetchInputs(number) {
  const inputs = emptyInputs();
  inputs.prNumber = number;

  try {
    Object.assign(inputs, fetchPullRequestCore(number));
  } catch (error) {
    inputs.fetchReasons.push(`PR core fetch failed: ${errorMessage(error)}`);
  }

  try {
    Object.assign(inputs, fetchChangedFiles(number));
  } catch (error) {
    inputs.fetchReasons.push(`changed-files fetch failed: ${errorMessage(error)}`);
  }

  try {
    Object.assign(inputs, fetchReviewThreads(number));
  } catch (error) {
    inputs.fetchReasons.push(`review-thread fetch failed: ${errorMessage(error)}`);
  }

  if (inputs.headRefOid) {
    // Keep fetchReasons out of Object.assign — assigning would replace the
    // accumulated array (losing earlier reasons) and then re-pushing would duplicate.
    const { fetchReasons: rollupReasons, ...rollup } = fetchRollup(inputs.headRefOid);
    Object.assign(inputs, rollup);
    inputs.fetchReasons.push(...rollupReasons);
  } else {
    inputs.fetchReasons.push('statuses/checks fetch skipped because the head SHA is unknown');
  }

  const claim = parseLoopClaim({ branch: inputs.headRefName, body: inputs.body });
  let commitOids = [];
  try {
    commitOids = fetchPrCommitOids(number);
  } catch (error) {
    inputs.fetchReasons.push(`PR commit ancestry fetch failed: ${errorMessage(error)}`);
  }
  Object.assign(inputs, deriveAttestedEvidence(inputs, commitOids));

  if (claim.valid) {
    try {
      const issueEvidence = fetchLinkedIssueEvidence(claim.issue, inputs.ownership);
      inputs.linkedIssue = issueEvidence.linkedIssue;
      inputs.ownership = issueEvidence.ownership;
    } catch (error) {
      inputs.fetchReasons.push(`linked-issue eligibility fetch failed: ${errorMessage(error)}`);
    }
  } else {
    inputs.fetchReasons.push(`loop claim is invalid: ${claim.reasonCode}`);
  }

  if (SAFE_LABELS.some((label) => inputs.labels.includes(label))) {
    try {
      inputs.authorization = fetchLiveAuthorization(
        number,
        inputs.headRefOid,
        inputs.labels,
        inputs.authorization,
      );
    } catch (error) {
      inputs.fetchReasons.push(`human-authorization event fetch failed: ${errorMessage(error)}`);
    }
  }

  const { fetchReasons: killSwitchReasons, ...killSwitch } = fetchKillSwitch();
  Object.assign(inputs, killSwitch);
  inputs.fetchReasons.push(...(killSwitchReasons ?? []));

  try {
    inputs.executorIdentity = fetchExecutorIdentity();
  } catch (error) {
    inputs.fetchReasons.push(`merge executor identity fetch failed: ${errorMessage(error)}`);
  }

  try {
    inputs.serverPolicy = fetchLiveServerPolicy();
  } catch (error) {
    inputs.fetchReasons.push(`live server-policy fetch failed: ${errorMessage(error)}`);
  }
  return inputs;
}

function changedPaths(pr) {
  const entries = Array.isArray(pr.fileEntries)
    ? pr.fileEntries
    : Array.isArray(pr.files)
      ? pr.files
      : [];
  const paths = [];
  let malformed = false;
  for (const entry of entries) {
    if (typeof entry === 'string') {
      paths.push(entry);
      continue;
    }
    const current = entry?.filename ?? entry?.path;
    const previous = entry?.previous_filename ?? entry?.previousFilename;
    if (typeof current !== 'string' || current.length === 0) malformed = true;
    else paths.push(current);
    if (typeof previous === 'string' && previous.length > 0) paths.push(previous);
  }
  return { entries, paths, malformed };
}

function isActionsCheckRun(checkRun) {
  const slug = String(checkRun?.app?.slug ?? '').toLowerCase();
  const name = String(checkRun?.app?.name ?? '').toLowerCase();
  return slug === 'github-actions' || name === 'github actions';
}

function pathBAllowed(path) {
  return REVERSIBLE_RES.some((re) => re.test(path));
}

function normalizedCheckRun(checkRun) {
  return {
    name: checkRun?.name,
    headOid: checkRun?.headOid ?? checkRun?.head_sha ?? checkRun?.headSha,
    status: checkRun?.status ?? (checkRun?.conclusion ? 'COMPLETED' : null),
    conclusion: checkRun?.conclusion,
    app: {
      id: checkRun?.app?.id,
      slug: checkRun?.app?.slug,
    },
  };
}

function mergeAuthorizationInput(pr, path) {
  const claim = parseLoopClaim({ branch: pr.headRefName, body: pr.body });
  return {
    config: {
      repository: REPOSITORY,
      baseBranch: BASE_BRANCH,
      mergePolicy: AUTOMERGE_MODE === 'all-green' ? 'auto' : 'ratified',
      baseFreshnessStrategy: BASE_FRESHNESS_STRATEGY,
      loopLogin: LOOP_LOGIN,
      trustedHumanLogins: TRUSTED_HUMAN_LOGINS,
      automationAppIds: TRUSTED_AUTOMATION_APP_IDS,
      authorizationAppIds: TRUSTED_AUTHORIZATION_APP_IDS,
      requiredApprovingReviewCount: REQUIRED_APPROVING_REVIEW_COUNT,
      requireCodeOwnerReviews: REQUIRE_CODE_OWNER_REVIEWS,
      requiredChecks: requiredCheckContracts(),
    },
    pr: {
      number: pr.prNumber,
      complete: pr.coreComplete === true,
      state: upper(pr.state),
      isDraft: pr.isDraft,
      baseRefName: pr.baseRefName,
      headRefName: pr.headRefName,
      headRefOid: pr.headRefOid,
      headRepository: {
        owner: pr.headRepository?.owner?.login ?? pr.headRepository?.owner,
        name: pr.headRepository?.name,
      },
      labels: pr.labels,
      reviewDecision: upper(pr.reviewDecision),
      reviewRequests: pr.reviewRequests,
      claim: {
        ok: claim.valid,
        issue: claim.issue,
        branchIssue: claim.branchIssue,
        bodyIssue: claim.bodyIssue,
      },
      linkedIssue: pr.linkedIssue,
      ownership: pr.ownership,
      lifecycle: pr.lifecycle,
      path,
      authorization: pr.authorization,
      checks: Array.isArray(pr.checkRuns) ? pr.checkRuns.map(normalizedCheckRun) : null,
      checksComplete: pr.rollupComplete === true,
      conversationsResolved:
        pr.threadPaginationComplete === true
        && Array.isArray(pr.reviewThreads)
        && pr.reviewThreads.every(
          (thread) => thread.isResolved === true || thread.latestIsOutdated === true,
        ),
      killSwitch: {
        complete: pr.killSwitch?.known === true,
        active: pr.killSwitch?.active,
      },
    },
    executorIdentity: pr.executorIdentity,
    serverPolicy: pr.serverPolicy,
  };
}

/**
 * Pure policy decision. Signal collection, pagination, and merge execution are all
 * outside this function so fixtures can drive the complete orchestration without a network.
 *
 * @returns {{allow:boolean, reasons:string[], path:'A'|'B'|'all-green'|'none'}}
 */
export function decide(pr) {
  const reasons = [...(pr.fetchReasons ?? [])];
  const labels = Array.isArray(pr.labels) ? pr.labels : [];
  const { entries, paths, malformed } = changedPaths(pr);
  const headRefOid = pr.headRefOid;

  if (!Array.isArray(pr.labels)) reasons.push('PR labels are missing or invalid');
  if (!Array.isArray(pr.reviewRequests)) reasons.push('review requests are missing or invalid');
  if (!Array.isArray(pr.reviewThreads)) reasons.push('review threads are missing or invalid');
  if (malformed) reasons.push('changed-files response contained an entry without a filename');
  if (pr.filePaginationComplete !== true) reasons.push('changed-files pagination incomplete or unknown');
  if (!Number.isInteger(pr.changedFiles)) reasons.push('changed-files count is missing or invalid');
  else if (pr.changedFiles !== entries.length) {
    reasons.push(`changed-files count mismatch (GitHub reports ${pr.changedFiles}, fetched ${entries.length})`);
  }

  if (pr.threadPaginationComplete !== true) reasons.push('review-thread pagination incomplete or unknown');
  if (pr.reviewRequestsComplete !== true) reasons.push('review-request pagination incomplete or unknown');
  if (pr.rollupComplete !== true) reasons.push('status/check rollup pagination incomplete or unknown');

  if (upper(pr.state) !== 'OPEN') reasons.push(`PR is not OPEN (state=${pr.state ?? 'unknown'})`);
  if (pr.isDraft !== false) reasons.push(pr.isDraft === true ? 'PR is still a draft' : 'draft state is unknown');
  if (pr.baseRefName !== BASE_BRANCH) reasons.push(`base branch is not ${BASE_BRANCH} (base=${pr.baseRefName ?? 'unknown'})`);

  const headOwner = pr.headRepository?.owner?.login ?? pr.headRepository?.owner;
  const headName = pr.headRepository?.name;
  if (headOwner !== REPOSITORY.owner || headName !== REPOSITORY.name) {
    reasons.push(`head repository is not ${REPO_SLUG} (head=${headOwner ?? 'unknown'}/${headName ?? 'unknown'})`);
  }

  const hardLabels = [
    'human:authorize',
    'human:legal',
    'automerge:halt',
    'do-not-merge',
    'loop-blocked',
    'needs-human',
  ];
  for (const label of hardLabels) {
    if (labels.includes(label)) reasons.push(`hard-block label present: ${label}`);
  }

  for (const decision of ['CHANGES_REQUESTED', 'REVIEW_REQUIRED']) {
    if (upper(pr.reviewDecision) === decision) reasons.push(`review decision is ${decision}`);
  }
  if (Array.isArray(pr.reviewRequests) && pr.reviewRequests.length > 0) {
    reasons.push(`pending review request(s): ${pr.reviewRequests.map((request) => request.reviewer ?? request).join(', ')}`);
  }

  const unresolved = (pr.reviewThreads ?? []).filter(
    (thread) => thread.isResolved !== true && thread.latestIsOutdated !== true,
  );
  if (unresolved.length > 0) reasons.push(`${unresolved.length} unresolved non-outdated review thread(s)`);
  if (
    BASE_FRESHNESS_STRATEGY === 'direct-strict'
    && upper(pr.mergeStateStatus) !== 'CLEAN'
  ) {
    reasons.push(`mergeStateStatus is not CLEAN (status=${pr.mergeStateStatus ?? 'unknown'})`);
  }

  if (!headRefOid || !/^[0-9a-f]{40}$/i.test(headRefOid)) reasons.push('headRefOid is missing or invalid');
  const statuses = Array.isArray(pr.statuses) ? pr.statuses : [];
  const headStatuses = statuses.filter((status) => status.sha === headRefOid);
  for (const status of statuses) {
    if (status.sha !== headRefOid) reasons.push(`status context ${status.context ?? 'unknown'} is not on fetched headRefOid`);
  }
  for (const status of headStatuses) {
    if (String(status.context ?? '').startsWith('agentic/')) {
      reasons.push(`agentic evidence must be an attributable CheckRun, not commit status ${status.context}`);
    }
  }

  const checkRuns = Array.isArray(pr.checkRuns) ? pr.checkRuns : [];
  const plainStatusNames = new Set(statuses.map((status) => status.context));
  for (const name of REQUIRED_CI_CHECKS) {
    if (plainStatusNames.has(name)) reasons.push(`CI context ${name} was user-posted as a plain status, not an Actions CheckRun`);
    const matches = checkRuns.filter((checkRun) => checkRun.name === name);
    if (matches.length === 0) {
      reasons.push(`missing required Actions CheckRun: ${name}`);
      continue;
    }
    if (matches.length > 1) reasons.push(`duplicate CI context: ${name}`);
    for (const checkRun of matches) {
      if (!isActionsCheckRun(checkRun)) reasons.push(`CI context ${name} is not from the GitHub Actions app`);
      const checkHead = checkRun.head_sha ?? checkRun.headSha;
      if (checkHead !== headRefOid) reasons.push(`CI context ${name} is not on fetched headRefOid`);
      if (upper(checkRun.conclusion) !== 'SUCCESS') {
        reasons.push(`CI context ${name} is not SUCCESS (conclusion=${checkRun.conclusion ?? 'unknown'})`);
      }
    }
  }

  // Unconditional triggered-checks floor: whatever CI actually ran on the head must be green —
  // no pending runs, no failures — regardless of REQUIRED_CI_CHECKS. Path-filtered repos keep
  // the required list empty (docs-only PRs trigger nothing and pass vacuously); this floor still
  // protects every PR that DID trigger checks. A concluded run with no `status` field counts as
  // completed (self-test fixtures and older API shapes omit it).
  for (const checkRun of checkRuns) {
    const checkHead = checkRun.head_sha ?? checkRun.headSha;
    if (checkHead !== headRefOid) continue; // stale runs on old SHAs never gate the head
    const runStatus = upper(checkRun.status);
    const conclusion = upper(checkRun.conclusion);
    if (runStatus && runStatus !== 'COMPLETED') {
      reasons.push(`triggered CheckRun ${checkRun.name ?? 'unknown'} has not completed (status=${checkRun.status})`);
    } else if (!conclusion) {
      reasons.push(`triggered CheckRun ${checkRun.name ?? 'unknown'} has no conclusion`);
    } else if (conclusion !== 'SUCCESS' && conclusion !== 'NEUTRAL' && conclusion !== 'SKIPPED') {
      reasons.push(`triggered CheckRun ${checkRun.name ?? 'unknown'} is not green (conclusion=${checkRun.conclusion})`);
    }
  }
  for (const status of headStatuses) {
    if (String(status.context ?? '').startsWith('agentic/')) continue;
    if (upper(status.state) !== 'SUCCESS') {
      reasons.push(`status context ${status.context ?? 'unknown'} is not SUCCESS (state=${status.state ?? 'unknown'})`);
    }
  }

  const killSwitch = pr.killSwitch;
  if (killSwitch?.known !== true) reasons.push('automerge:halt kill-switch state is unknown');
  else if (killSwitch.active === true) reasons.push('automerge:halt kill-switch is active; all automerges are paused');

  for (const hit of matchMergeProtected(paths, EXTRA_PROTECTED_PATHS)) {
    reasons.push(`protected path (${hit.family}): ${hit.file}`);
  }

  const pathA = SAFE_LABELS.some((label) => labels.includes(label));
  const hasKnownSize = Number.isInteger(pr.changedFiles) && Number.isInteger(pr.additions) && Number.isInteger(pr.deletions);
  const pathBFiles = entries.length > 0 && paths.length > 0 && paths.every(pathBAllowed);
  const pathBSize = hasKnownSize && pr.changedFiles <= 20 && pr.additions + pr.deletions <= 400;
  const pathB = pathBFiles && pathBSize && pr.filePaginationComplete === true && !malformed && pr.changedFiles === entries.length;
  // 'all-green' authorizes any complete, well-formed changed-file set; every other
  // check in this function (protected paths, hard-block labels, evidence, threads,
  // kill-switch) still applies — the mode widens the CLASS, never the floor.
  const allGreen =
    AUTOMERGE_MODE === 'all-green' &&
    entries.length > 0 &&
    pr.filePaginationComplete === true &&
    !malformed &&
    pr.changedFiles === entries.length;
  const path = pathA ? 'A' : pathB ? 'B' : allGreen ? 'all-green' : 'none';

  if (path === 'none') {
    if (AUTOMERGE_MODE === 'all-green') {
      reasons.push('not authorized: changed-file evidence incomplete or empty');
    } else {
      if (!pathBFiles) reasons.push(`not authorized: Path B requires every current and previous file path to match the reversible allowlist (${REVERSIBLE_PATHS.join(', ') || 'empty'})`);
      if (!pathBSize) {
        if (!hasKnownSize) reasons.push('not authorized: Path B changed-file size is unknown');
        else {
          if (pr.changedFiles > 20) reasons.push(`not authorized: Path B has too many files (${pr.changedFiles} > 20)`);
          if (pr.additions + pr.deletions > 400) reasons.push(`not authorized: Path B has too many changed lines (${pr.additions + pr.deletions} > 400)`);
        }
      }
    }
  }

  const authorization = authorizeMerge(mergeAuthorizationInput(pr, path));
  reasons.push(...authorization.reasons.map((reason) => `merge authorization: ${reason}`));

  return { allow: reasons.length === 0, reasons, path };
}

function apiErrorStatus(error) {
  if (Number(error?.status) === 409 || Number(error?.code) === 409) return 409;
  return /(?:HTTP|status|response)[^\d]{0,20}409\b/i.test(errorMessage(error)) ? 409 : null;
}

function defaultMergeExecutor(number, expectedExecutor) {
  return ({ sha, squash }) => {
    if (squash !== true) throw new Error('merge executor requires squash=true');
    const actualExecutor = fetchExecutorIdentity();
    if (
      actualExecutor.complete !== true
      || actualExecutor.login !== LOOP_LOGIN
      || actualExecutor.login !== expectedExecutor?.login
      || actualExecutor.id !== expectedExecutor?.id
    ) {
      throw Object.assign(
        new Error('merge credential identity changed or does not match the dedicated loop login'),
        { code: 'EXECUTOR_IDENTITY_MISMATCH' },
      );
    }
    return ghJson(
      ghApiArgs(
        `repos/${REPO_SLUG}/pulls/${number}/merge`,
        ['--method', 'PUT', '-f', 'merge_method=squash', '-f', `sha=${sha}`],
      ),
    );
  };
}

function defaultConfirmMerged(number) {
  const pr = ghJson(ghApiArgs(`repos/${REPO_SLUG}/pulls/${number}`));
  return { merged: pr.merged === true, headSha: pr.head?.sha ?? null };
}

function shortSleep() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
}

/**
 * Run the orchestration against already-collected inputs. The merge executor and
 * confirmation refetch are injectable so self-test never reaches the network.
 */
export function run(inputs, {
  dryRun = false,
  mergeExecutor,
  confirmMerged,
  sleep = shortSleep,
  strategy = BASE_FRESHNESS_STRATEGY,
} = {}) {
  const decision = decide(inputs);
  const result = { exitCode: decision.allow ? 0 : 1, decision, reasons: [...decision.reasons] };
  if (!decision.allow) return result;

  if (strategy !== BASE_FRESHNESS_STRATEGY || strategy !== 'direct-strict') {
    result.exitCode = 1;
    result.reasons.push(
      `unsupported submission strategy: ${strategy}; v0.40 enables direct-strict only`,
    );
    return result;
  }
  if (dryRun) return result;
  const execute = mergeExecutor
    ?? defaultMergeExecutor(inputs.prNumber, inputs.executorIdentity);
  const confirm = confirmMerged
    ?? (() => defaultConfirmMerged(inputs.prNumber));
  const mergeArgs = { sha: inputs.headRefOid, squash: true };
  try {
    const response = execute(mergeArgs);
    if (response?.merged === true) {
      result.merged = true;
      return result;
    }
    const message = response?.message ?? 'GitHub did not confirm the merge';
    result.exitCode = 1;
    result.reasons.push(`merge refused by GitHub: ${message}`);
    return result;
  } catch (error) {
    const message = errorMessage(error);
    if (error?.code === 'EXECUTOR_IDENTITY_MISMATCH') {
      result.exitCode = 1;
      result.reasons.push(`merge executor precondition failed: ${message}`);
      return result;
    }
    if (apiErrorStatus(error) === 409) {
      result.exitCode = 1;
      result.reasons.push(`compare-and-swap merge refused (HTTP 409): ${message}`);
      return result;
    }

    result.reasons.push(`merge attempt failed: ${message}`);
    const confirmationReasons = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        // Bind the confirmation to the SHA we attempted: merged=true with a DIFFERENT
        // head means someone else pushed and merged during the ambiguity window — that
        // is not this tool's merge, and the outcome must stay unknown.
        const confirmation = confirm();
        const merged = confirmation?.merged === true;
        const headSha = confirmation?.headSha ?? null;
        if (merged && headSha === inputs.headRefOid) {
          result.exitCode = 0;
          result.merged = true;
          result.confirmed = true;
          return result;
        }
        confirmationReasons.push(
          merged
            ? `confirmation attempt ${attempt}: merged=true but head ${headSha ?? 'unknown'} is not the attempted ${inputs.headRefOid}`
            : `confirmation attempt ${attempt}: merged=false`,
        );
      } catch (confirmationError) {
        confirmationReasons.push(`confirmation attempt ${attempt} failed: ${errorMessage(confirmationError)}`);
      }
      if (attempt < 3) sleep();
    }
    result.exitCode = 1;
    result.reasons.push(
      `LOUD: MERGE OUTCOME UNKNOWN after 3 confirmation attempts; human must inspect immediately (${confirmationReasons.join('; ')})`,
    );
    return result;
  }
}

// ── Self-test fixtures DERIVE from the config block so they stay valid for any
// filled config. pathFromGlob turns the first glob of a list into a concrete path.
function pathFromGlob(glob, leaf) {
  if (!glob.includes('*')) return glob;
  return glob.replace(/\*\*.*$/, leaf).replace(/\*/g, 'x');
}
const ALLOWED_PATH = pathFromGlob(REVERSIBLE_PATHS[0] ?? 'docs/**', 'autoloop-selftest.md');
const allowedPathN = (index) => pathFromGlob(REVERSIBLE_PATHS[0] ?? 'docs/**', `selftest-${index}.md`);
// A path matching no generic family; Path A carries no path-class requirement, so this
// exercises the label route. (If your EXTRA_PROTECTED_PATHS happens to cover it, the
// self-test will fail loudly — pick config that leaves at least one neutral path.)
const NEUTRAL_PATH = 'zz-selftest/neutral-change.txt';
const ALLOW_ALL = AUTOMERGE_MODE === 'all-green';

function makeCheckRuns() {
  return requiredCheckContracts().map(({ name, appIds }) => ({
    name,
    status: 'completed',
    conclusion: 'success',
    head_sha: HEAD_SHA,
    app: {
      id: appIds[0],
      slug: name.startsWith('agentic/') ? 'autoloop' : 'github-actions',
      name: name.startsWith('agentic/') ? 'Autoloop' : 'GitHub Actions',
    },
  }));
}

function makeInput({
  files = [ALLOWED_PATH],
  fileEntries,
  labels = [],
  headRefName = `feat/gh-${LOOP_ISSUE}-safe-change`,
  body = `Closes #${LOOP_ISSUE}`,
  ...overrides
} = {}) {
  const entries = fileEntries ?? files.map((filename) => ({ filename, previous_filename: null }));
  return {
    prNumber: 138,
    coreComplete: true,
    state: 'OPEN',
    isDraft: false,
    baseRefName: BASE_BRANCH,
    headRefName,
    body,
    headRefOid: HEAD_SHA,
    headRepository: { owner: REPOSITORY.owner, name: REPOSITORY.name },
    labels: [...new Set(labels)],
    changedFiles: entries.length,
    additions: 10,
    deletions: 5,
    reviewDecision: 'APPROVED',
    reviewRequests: [],
    reviewRequestsComplete: true,
    mergeStateStatus: 'CLEAN',
    fileEntries: entries,
    filePaginationComplete: true,
    reviewThreads: [],
    threadPaginationComplete: true,
    statuses: [],
    checkRuns: makeCheckRuns(),
    rollupComplete: true,
    killSwitch: { known: true, active: false },
    linkedIssue: {
      complete: true,
      number: LOOP_ISSUE,
      state: 'OPEN',
      labels: ['loop-ready', 'loop-delivered'],
      bodyHash: ISSUE_BODY_HASH,
      createdAt: '2026-07-24T00:00:00Z',
      lastEditedAt: '2026-07-24T00:01:00Z',
      blocked: false,
      dependenciesClear: true,
      dependenciesComplete: true,
      dependencies: [],
      loopReady: {
        complete: true,
        eventId: 7001,
        actor: TRUSTED_HUMAN_LOGINS[0],
        labeledAt: '2026-07-24T00:02:00Z',
        roleName: 'maintain',
      },
    },
    ownership: {
      complete: true,
      issueBodyHash: ISSUE_BODY_HASH,
      claimCommitAncestor: true,
      frozenPlanPresent: true,
      frozenPlanHash: FROZEN_PLAN_HASH,
      frozenPlanCommentId: 'IC_kwDOAutoloop7',
      frozenPlanAuthor: LOOP_LOGIN,
      frozenPlanCommentVerified: true,
    },
    lifecycle: {
      complete: true,
      delivered: true,
      headOid: HEAD_SHA,
      premergeRecord: true,
    },
    authorization: {
      complete: true,
      pullRequest: 138,
      actor: TRUSTED_HUMAN_LOGINS[0],
      headOid: HEAD_SHA,
      label: labels.find((label) => SAFE_LABELS.includes(label)) ?? SAFE_LABELS[0],
      labelEventId: 12001,
      labeledAt: '2026-07-24T00:03:00Z',
      eventVerified: true,
      afterCurrentHead: true,
      roleName: 'maintain',
      check: {
        name: 'agentic/human-authorization',
        headOid: HEAD_SHA,
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        app: { id: TRUSTED_AUTHORIZATION_APP_IDS[0] },
      },
    },
    executorIdentity: {
      complete: true,
      login: LOOP_LOGIN,
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
      requiredApprovingReviewCount: REQUIRED_APPROVING_REVIEW_COUNT,
      requireCodeOwnerReviews: REQUIRE_CODE_OWNER_REVIEWS,
      dismissStaleReviews: true,
      requireLastPushApproval: true,
      forcePushesAllowed: false,
      deletionsAllowed: false,
      requiredChecks: requiredCheckContracts(),
      queueRequired: false,
      rulesetsComplete: true,
      bypassActorsVisible: true,
    },
    fetchReasons: [],
    ...overrides,
  };
}

function protectedFixture(name, path) {
  return { name, input: makeInput({ files: [path], labels: ['risk:pure-deletion'] }), expectExit: 1, expectCalls: 0 };
}

// Declarative, network-free fixtures for the policy and orchestration.
export const FIXTURES = [
  {
    name: 'Path A allow → mock merge called exactly once with {sha, squash}',
    input: makeInput({ files: [NEUTRAL_PATH], labels: ['risk:pure-deletion'] }),
    expectExit: 0,
    expectCalls: 1,
    expectArgs: { sha: HEAD_SHA, squash: true },
  },
  {
    name: 'Path B allow → mock merge called exactly once with {sha, squash}',
    input: makeInput({ files: [ALLOWED_PATH] }),
    expectExit: 0,
    expectCalls: 1,
    expectArgs: { sha: HEAD_SHA, squash: true },
  },
  {
    name: '--dry-run on an allow → zero merge calls',
    input: makeInput({ labels: ['risk:mechanical-refactor'], files: [NEUTRAL_PATH] }),
    dryRun: true,
    expectExit: 0,
    expectCalls: 0,
  },
  {
    name: `unclassified path without a risk label (mode: ${AUTOMERGE_MODE})`,
    input: makeInput({ files: [NEUTRAL_PATH] }),
    expectExit: ALLOW_ALL ? 0 : 1,
    expectCalls: ALLOW_ALL ? 1 : 0,
  },
  { name: 'hard-block label human:authorize', input: makeInput({ labels: ['human:authorize'] }), expectExit: 1, expectCalls: 0 },
  { name: 'hard-block label human:legal', input: makeInput({ labels: ['human:legal'] }), expectExit: 1, expectCalls: 0 },
  { name: 'hard-block label automerge:halt', input: makeInput({ labels: ['automerge:halt'] }), expectExit: 1, expectCalls: 0 },
  { name: 'hard-block label do-not-merge', input: makeInput({ labels: ['do-not-merge'] }), expectExit: 1, expectCalls: 0 },
  { name: 'hard-block label loop-blocked', input: makeInput({ labels: ['loop-blocked'] }), expectExit: 1, expectCalls: 0 },
  { name: 'hard-block label needs-human', input: makeInput({ labels: ['needs-human'] }), expectExit: 1, expectCalls: 0 },
  {
    name: 'missing gate verdict on Path A',
    input: makeInput({
      labels: ['risk:pure-deletion'],
      checkRuns: makeCheckRuns().filter((check) => check.name !== 'agentic/gate'),
    }),
    expectExit: 1,
    expectCalls: 0,
  },
  {
    name: 'failing review on Path A',
    input: makeInput({
      labels: ['risk:pure-deletion'],
      checkRuns: makeCheckRuns().map((check) =>
        check.name === 'agentic/review' ? { ...check, conclusion: 'failure' } : check),
    }),
    expectExit: 1,
    expectCalls: 0,
  },
  {
    name: 'missing verdict on Path B',
    input: makeInput({
      checkRuns: makeCheckRuns().filter((check) => check.name !== 'agentic/review'),
    }),
    expectExit: 1,
    expectCalls: 0,
  },
  {
    name: 'non-success agentic CheckRun',
    input: makeInput({
      checkRuns: [
        ...makeCheckRuns(),
        {
          name: 'agentic/extra',
          status: 'completed',
          conclusion: 'failure',
          head_sha: HEAD_SHA,
          app: { id: TRUSTED_AUTOMATION_APP_IDS[0], slug: 'autoloop' },
        },
      ],
    }),
    expectExit: 1,
    expectCalls: 0,
  },
  {
    name: 'branch and body claim mismatch blocks',
    input: makeInput({ headRefName: 'feat/gh-7-safe-change', body: 'Closes #8' }),
    expectExit: 1,
    expectCalls: 0,
  },
  {
    name: 'missing linked issue and ownership evidence blocks',
    input: makeInput({ linkedIssue: null, ownership: null }),
    expectExit: 1,
    expectCalls: 0,
  },
  {
    name: 'untrusted producer cannot spoof an agentic verdict',
    input: makeInput({
      checkRuns: makeCheckRuns().map((check) =>
        check.name === 'agentic/gate' ? { ...check, app: { id: 999, slug: 'untrusted' } } : check),
    }),
    expectExit: 1,
    expectCalls: 0,
  },
  {
    name: 'plain commit status cannot spoof an agentic verdict',
    input: makeInput({
      statuses: [{
        context: 'agentic/gate',
        state: 'success',
        sha: HEAD_SHA,
        creator: { login: LOOP_LOGIN },
      }],
    }),
    expectExit: 1,
    expectCalls: 0,
  },
  {
    name: 'missing non-bypassable server-policy evidence blocks',
    input: makeInput({ serverPolicy: null }),
    expectExit: 1,
    expectCalls: 0,
  },
  {
    name: 'Path A authorization on an old head blocks',
    input: makeInput({
      labels: ['risk:pure-deletion'],
      authorization: {
        ...makeInput().authorization,
        headOid: 'f'.repeat(40),
      },
    }),
    expectExit: 1,
    expectCalls: 0,
  },
  { name: 'draft PR', input: makeInput({ isDraft: true }), expectExit: 1, expectCalls: 0 },
  { name: 'wrong base branch', input: makeInput({ baseRefName: 'some-feature-branch' }), expectExit: 1, expectCalls: 0 },
  { name: 'fork head', input: makeInput({ headRepository: { owner: 'someone-else', name: REPOSITORY.name } }), expectExit: 1, expectCalls: 0 },
  { name: 'CHANGES_REQUESTED', input: makeInput({ reviewDecision: 'CHANGES_REQUESTED' }), expectExit: 1, expectCalls: 0 },
  { name: 'REVIEW_REQUIRED', input: makeInput({ reviewDecision: 'REVIEW_REQUIRED' }), expectExit: 1, expectCalls: 0 },
  { name: 'pending review request', input: makeInput({ reviewRequests: [{ reviewer: 'user:reviewer' }] }), expectExit: 1, expectCalls: 0 },
  { name: 'unresolved non-outdated review thread', input: makeInput({ reviewThreads: [{ isResolved: false, latestIsOutdated: false }] }), expectExit: 1, expectCalls: 0 },
  { name: 'incomplete review-thread pagination', input: makeInput({ threadPaginationComplete: false }), expectExit: 1, expectCalls: 0 },
  { name: 'incomplete file pagination (count mismatch)', input: makeInput({ changedFiles: 2 }), expectExit: 1, expectCalls: 0 },
  { name: 'incomplete status/check rollup', input: makeInput({ rollupComplete: false }), expectExit: 1, expectCalls: 0 },
  { name: 'non-CLEAN mergeStateStatus', input: makeInput({ mergeStateStatus: 'DIRTY' }), expectExit: 1, expectCalls: 0 },
  // CI-evidence fixtures only exist when the config declares required checks.
  ...(REQUIRED_CI_CHECKS.length
    ? [
        {
          name: 'missing CI check',
          input: makeInput({
            checkRuns: makeCheckRuns().filter((check) => check.name !== REQUIRED_CI_CHECKS[0]),
          }),
          expectExit: 1,
          expectCalls: 0,
        },
        {
          name: 'user-posted (non-CheckRun) CI context',
          input: makeInput({ statuses: [...makeInput().statuses, { context: REQUIRED_CI_CHECKS[0], state: 'success', sha: HEAD_SHA }] }),
          expectExit: 1,
          expectCalls: 0,
        },
        {
          name: 'duplicate CI context',
          input: makeInput({
            checkRuns: [
              ...makeCheckRuns(),
              makeCheckRuns().find((check) => check.name === REQUIRED_CI_CHECKS[0]),
            ],
          }),
          expectExit: 1,
          expectCalls: 0,
        },
      ]
    : []),
  // Triggered-checks floor: independent of REQUIRED_CI_CHECKS.
  {
    name: 'triggered CheckRun pending blocks',
    input: makeInput({ checkRuns: [...makeCheckRuns(), { name: 'ci-job', status: 'in_progress', head_sha: HEAD_SHA, app: { slug: 'github-actions' } }] }),
    expectExit: 1,
    expectCalls: 0,
  },
  {
    name: 'triggered CheckRun failure blocks',
    input: makeInput({ checkRuns: [...makeCheckRuns(), { name: 'ci-job', conclusion: 'failure', head_sha: HEAD_SHA, app: { slug: 'github-actions' } }] }),
    expectExit: 1,
    expectCalls: 0,
  },
  {
    name: 'triggered CheckRuns green (success + skipped) merge',
    input: makeInput({ checkRuns: [...makeCheckRuns(), { name: 'ci-job', conclusion: 'success', head_sha: HEAD_SHA, app: { slug: 'github-actions' } }, { name: 'ci-skip', conclusion: 'skipped', head_sha: HEAD_SHA, app: { slug: 'github-actions' } }] }),
    expectExit: 0,
    expectCalls: 1,
  },
  {
    name: 'stale CheckRun on old SHA does not gate',
    input: makeInput({ checkRuns: [...makeCheckRuns(), { name: 'ci-old', conclusion: 'failure', head_sha: 'f'.repeat(40), app: { slug: 'github-actions' } }] }),
    expectExit: 0,
    expectCalls: 1,
  },
  {
    name: 'failing third-party status blocks',
    input: makeInput({ statuses: [...makeInput().statuses, { context: 'ci/thirdparty', state: 'failure', sha: HEAD_SHA }] }),
    expectExit: 1,
    expectCalls: 0,
  },
  { name: 'kill-switch active', input: makeInput({ killSwitch: { known: true, active: true } }), expectExit: 1, expectCalls: 0 },
  { name: 'kill-switch query failure', input: makeInput({ killSwitch: { known: false, active: false } }), expectExit: 1, expectCalls: 0 },

  protectedFixture('protected crypt path segment', 'lib/utils/crypt-helper.ts'),
  protectedFixture('protected secret path segment', 'lib/utils/secret-store.ts'),
  protectedFixture('protected token path segment', 'lib/utils/api-token.ts'),
  protectedFixture('protected credential path segment', 'lib/services/credentialVault.ts'),
  protectedFixture('protected nested .env file', 'apps/web/.env.local'),
  protectedFixture("the tool's own path with everything green", 'tools/agentic/auto-merge.mjs'),
  protectedFixture('protected .github/**', '.github/workflows/ci.yml'),
  protectedFixture('protected .claude/**', '.claude/settings.json'),
  protectedFixture('protected .codex/**', '.codex/hooks.json'),
  protectedFixture('protected .agents/**', '.agents/plugins/marketplace.json'),
  // Crown-jewel fixtures derive from the config; absent config = no fixtures (loudly generic).
  ...EXTRA_PROTECTED_PATHS.map((glob) =>
    protectedFixture(`extra-protected ${glob}`, pathFromGlob(glob, 'selftest-jewel.ts')),
  ),
  protectedFixture('protected root dot-directory (.codex/x)', '.codex/x'),
  protectedFixture('protected docs/agentic/**', 'docs/agentic/STATE.md'),
  protectedFixture('protected docs/agentic/checklist.md', 'docs/agentic/checklist.md'),
  {
    // Carve-out: ARCH.md is DATA, not policy — a protected path would override Path A and block,
    // so this proves the map no longer does. STATE.md above still blocks with the same label.
    name: 'docs/agentic/ARCH.md is NOT protected (map carve-out) → allow',
    input: makeInput({ files: ['docs/agentic/ARCH.md'], labels: ['risk:pure-deletion'] }),
    expectExit: 0,
    expectCalls: 1,
    expectArgs: { sha: HEAD_SHA, squash: true },
  },
  {
    // Surgical: a mixed PR touching ARCH.md AND a still-protected sibling stays blocked.
    name: 'docs/agentic/ARCH.md + STATE.md together → still blocked (STATE protected)',
    input: makeInput({ files: ['docs/agentic/ARCH.md', 'docs/agentic/STATE.md'], labels: ['risk:pure-deletion'] }),
    expectExit: 1,
    expectCalls: 0,
  },
  protectedFixture('protected CLAUDE.md', 'CLAUDE.md'),
  protectedFixture('protected AGENTS.override.md', 'AGENTS.override.md'),
  protectedFixture('protected AGENTS.md', 'AGENTS.md'),
  protectedFixture('protected nested AGENTS.md', 'src/AGENTS.md'),
  protectedFixture('protected nested CLAUDE.md', 'packages/web/CLAUDE.md'),
  protectedFixture('protected nested AGENTS.override.md', 'a/b/AGENTS.override.md'),
  protectedFixture('protected docker-compose.yml', 'docker-compose.yml'),
  protectedFixture('protected Dockerfile*', 'Dockerfile.prod'),
  protectedFixture('protected nested package.json', 'packages/server/package.json'),
  protectedFixture('protected nested lockfile', 'packages/server/package-lock.json'),
  protectedFixture('protected nested *.lock file', 'packages/server/cache.lock'),
  protectedFixture('protected nested tsconfig*', 'packages/ui/tsconfig.build.json'),
  protectedFixture('protected nested vite config', 'packages/ui/vite.config.ts'),
  protectedFixture('protected nested vitest config', 'packages/ui/vitest.config.ts'),
  protectedFixture('protected nested eslint config', 'packages/ui/eslint.config.js'),
  protectedFixture('protected nested postcss config', 'packages/ui/postcss.config.js'),
  protectedFixture('protected nested tailwind config', 'packages/ui/tailwind.config.js'),
  protectedFixture('protected data/**', 'data/state.sqlite'),
  {
    name: 'rename previous_filename=tools/agentic/auto-merge.mjs → an allowed path',
    input: makeInput({ labels: [], fileEntries: [{ filename: ALLOWED_PATH, previous_filename: 'tools/agentic/auto-merge.mjs' }] }),
    expectExit: 1,
    expectCalls: 0,
  },
  {
    name: 'mixed allowed+disallowed files',
    input: makeInput({ files: [ALLOWED_PATH, '.github/workflows/ci.yml'], labels: ['risk:pure-deletion'] }),
    expectExit: 1,
    expectCalls: 0,
  },
  {
    name: `21 files (size cap applies only to classified mode: ${AUTOMERGE_MODE})`,
    input: makeInput({ files: Array.from({ length: 21 }, (_, index) => allowedPathN(index)), additions: 200, deletions: 200 }),
    expectExit: ALLOW_ALL ? 0 : 1,
    expectCalls: ALLOW_ALL ? 1 : 0,
  },
  {
    name: `401 changed lines (size cap applies only to classified mode: ${AUTOMERGE_MODE})`,
    input: makeInput({ additions: 201, deletions: 200 }),
    expectExit: ALLOW_ALL ? 0 : 1,
    expectCalls: ALLOW_ALL ? 1 : 0,
  },
  {
    name: 'boundary exactly 20 files and exactly 400 lines → allow',
    input: makeInput({ files: Array.from({ length: 20 }, (_, index) => allowedPathN(100 + index)), additions: 200, deletions: 200 }),
    expectExit: 0,
    expectCalls: 1,
    expectArgs: { sha: HEAD_SHA, squash: true },
  },
  {
    name: 'CAS 409 from mock → resolves refusal',
    input: makeInput(),
    mergeBehavior: 'cas409',
    expectExit: 1,
    expectCalls: 1,
    expectConfirmCalls: 0,
  },
  {
    name: 'executor identity precondition failure never enters ambiguous confirmation',
    input: makeInput(),
    mergeBehavior: 'identity',
    expectExit: 1,
    expectCalls: 1,
    expectConfirmCalls: 0,
  },
  {
    name: 'merge-queue strategy fails closed before submission',
    input: makeInput(),
    strategy: 'merge-queue',
    expectExit: 1,
    expectCalls: 0,
    expectConfirmCalls: 0,
  },
  {
    name: 'merge-queue strategy also fails closed in dry-run',
    input: makeInput(),
    strategy: 'merge-queue',
    dryRun: true,
    expectExit: 1,
    expectCalls: 0,
    expectConfirmCalls: 0,
  },
  {
    name: 'mock timeout then confirm-merged=true → resolves success',
    input: makeInput(),
    mergeBehavior: 'timeout',
    confirmMerged: { merged: true, headSha: HEAD_SHA },
    expectExit: 0,
    expectCalls: 1,
    expectConfirmCalls: 1,
  },
  {
    name: 'mock timeout, merged=true but a DIFFERENT head → outcome unknown, exit 1',
    input: makeInput(),
    mergeBehavior: 'timeout',
    confirmMerged: { merged: true, headSha: 'b'.repeat(40) },
    expectExit: 1,
    expectCalls: 1,
    expectConfirmCalls: 3,
  },
];

/** Direct cases for the status-stamping helper — the REST shape has no per-item sha. */
function statusStampCases() {
  const cases = [];
  try {
    const stamped = collectCombinedStatuses(
      [{ sha: HEAD_SHA, total_count: 1, statuses: [{ context: 'agentic/gate', state: 'success' }] }],
      HEAD_SHA,
    );
    cases.push({ name: 'combined-status items are stamped with the page sha', ok: stamped[0]?.sha === HEAD_SHA });
  } catch {
    cases.push({ name: 'combined-status items are stamped with the page sha', ok: false });
  }
  let mismatchThrew = false;
  try {
    collectCombinedStatuses([{ sha: 'b'.repeat(40), total_count: 0, statuses: [] }], HEAD_SHA);
  } catch {
    mismatchThrew = true;
  }
  cases.push({ name: 'combined-status page for a different sha fails the fetch', ok: mismatchThrew });
  const base = makeInput();
  const ownership = {
    kind: 'ownership',
    v: 1,
    headOid: HEAD_SHA,
    issue: LOOP_ISSUE,
    issueBodyHash: ISSUE_BODY_HASH,
    claimCommitOid: 'd'.repeat(40),
    frozenPlanHash: FROZEN_PLAN_HASH,
    frozenPlanCommentId: 'IC_kwDOAutoloop7',
    frozenPlanAuthor: LOOP_LOGIN,
  };
  const policy = {
    kind: 'policy',
    v: 1,
    headOid: HEAD_SHA,
    issue: LOOP_ISSUE,
    delivered: true,
    premergeRecord: 'record-1',
  };
  const authorization = {
    kind: 'human-authorization',
    v: 1,
    headOid: HEAD_SHA,
    pullRequest: 138,
    actor: TRUSTED_HUMAN_LOGINS[0],
    label: SAFE_LABELS[0],
    labelEventId: 12001,
    labeledAt: '2026-07-24T00:03:00Z',
  };
  const evidence = deriveAttestedEvidence({
    ...base,
    checkRuns: [
      ...makeCheckRuns().map((check) => {
        if (check.name === 'agentic/ownership') {
          return { ...check, output: { summary: serializeAttestation(ownership) } };
        }
        if (check.name === 'agentic/policy') {
          return { ...check, output: { summary: serializeAttestation(policy) } };
        }
        return check;
      }),
      {
        name: 'agentic/human-authorization',
        status: 'completed',
        conclusion: 'success',
        head_sha: HEAD_SHA,
        app: { id: TRUSTED_AUTHORIZATION_APP_IDS[0], slug: 'autoloop-auth' },
        output: { summary: serializeAttestation(authorization) },
      },
    ],
  }, [ownership.claimCommitOid]);
  cases.push({
    name: 'trusted exact-head attestations hydrate merge evidence',
    ok:
      evidence.ownership?.claimCommitAncestor === true
      && evidence.ownership?.frozenPlanCommentId === ownership.frozenPlanCommentId
      && evidence.lifecycle?.premergeRecord === true
      && evidence.authorization?.pullRequest === 138
      && evidence.authorization?.actor === TRUSTED_HUMAN_LOGINS[0]
      && evidence.serverPolicy === null,
  });
  const staleEvidence = deriveAttestedEvidence({
    ...base,
    checkRuns: [{
      name: 'agentic/ownership',
      status: 'completed',
      conclusion: 'success',
      head_sha: HEAD_SHA,
      output: { summary: serializeAttestation({ ...ownership, headOid: 'e'.repeat(40) }) },
    }],
  }, [ownership.claimCommitOid]);
  cases.push({
    name: 'stale attestation cannot hydrate ownership',
    ok: staleEvidence.ownership === null,
  });
  return cases;
}

function restPaginationCases() {
  const cases = [];
  const responses = new Map([
    ['page-1', {
      data: [{ id: 1 }],
      link: '<https://api.github.com/page-2>; rel="next"',
    }],
    ['https://api.github.com/page-2', {
      data: [{ id: 2 }],
      link: null,
    }],
  ]);
  const pages = ghPaginated('page-1', (endpoint) => responses.get(endpoint));
  cases.push({
    name: 'REST pagination follows Link next even after a short page',
    ok: pages.length === 2
      && pages[0][0].id === 1
      && pages[1][0].id === 2,
  });
  let repeatedRejected = false;
  try {
    ghPaginated('page-1', () => ({
      data: [],
      link: '<https://api.github.com/page-1>; rel="next"',
    }));
  } catch {
    repeatedRejected = true;
  }
  cases.push({
    name: 'REST pagination rejects a repeated Link next target',
    ok: repeatedRejected,
  });
  const included = parseIncludedResponse(
    'HTTP/2.0 200 OK\r\nLink: <https://api.github.com/page-2>; rel="next"\r\n\r\n[]',
  );
  cases.push({
    name: 'included REST headers and JSON body parse independently',
    ok: Array.isArray(included.data)
      && included.link?.includes('rel="next"'),
  });
  return cases;
}

function liveEvidenceCases() {
  const ownership = {
    complete: true,
    issueBodyHash: ISSUE_BODY_HASH,
    claimCommitAncestor: true,
    frozenPlanPresent: true,
    frozenPlanHash: FROZEN_PLAN_HASH,
    frozenPlanCommentId: 'IC_kwDOAutoloop7',
    frozenPlanAuthor: LOOP_LOGIN,
  };
  const issueInput = {
    issue: {
      complete: true,
      number: LOOP_ISSUE,
      state: 'OPEN',
      body: `Work\n\n## Blocked by\n- #6`,
      labels: ['loop-ready', 'loop-delivered'],
      labelsComplete: true,
      createdAt: '2026-07-24T00:00:00Z',
      lastEditedAt: '2026-07-24T00:01:00Z',
    },
    timeline: {
      complete: true,
      items: [{
        id: 7001,
        event: 'labeled',
        label: { name: 'loop-ready' },
        actor: { login: 'maintainer' },
        created_at: '2026-07-24T00:02:00Z',
      }],
    },
    comments: {
      complete: true,
      items: [{
        id: ownership.frozenPlanCommentId,
        author: { login: LOOP_LOGIN },
        body: 'frozen plan',
      }],
    },
    dependencies: {
      complete: true,
      items: [{ number: 6, state: 'CLOSED' }],
    },
    loopReadyPermission: {
      complete: true,
      login: 'maintainer',
      roleName: 'maintain',
    },
    ownership: {
      ...ownership,
      frozenPlanHash: sha256('frozen plan'),
    },
    loopLogin: LOOP_LOGIN,
  };
  const issueEvidence = deriveLiveIssueEvidence(issueInput);
  const hardLabelEvidence = deriveLiveIssueEvidence({
    ...issueInput,
    issue: {
      ...issueInput.issue,
      labels: [...issueInput.issue.labels, 'loop-blocked'],
    },
  });
  const reopenedDependency = deriveLiveIssueEvidence({
    ...issueInput,
    dependencies: {
      complete: true,
      items: [{ number: 6, state: 'OPEN' }],
    },
  });
  const deletedPlan = deriveLiveIssueEvidence({
    ...issueInput,
    comments: { complete: true, items: [] },
  });
  const editedPlan = deriveLiveIssueEvidence({
    ...issueInput,
    comments: {
      complete: true,
      items: [{
        ...issueInput.comments.items[0],
        body: 'edited frozen plan',
      }],
    },
  });
  const emptyPlan = deriveLiveIssueEvidence({
    ...issueInput,
    comments: {
      complete: true,
      items: [{
        ...issueInput.comments.items[0],
        body: '',
      }],
    },
    ownership: {
      ...issueInput.ownership,
      frozenPlanHash: sha256(''),
    },
  });
  const incompleteTimeline = deriveLiveIssueEvidence({
    ...issueInput,
    timeline: { complete: false, items: issueInput.timeline.items },
  });

  const authorization = {
    complete: true,
    pullRequest: 138,
    actor: 'maintainer',
    headOid: HEAD_SHA,
    label: SAFE_LABELS[0],
    labelEventId: 12001,
    labeledAt: '2026-07-24T00:03:00Z',
    check: {
      name: 'agentic/human-authorization',
      headOid: HEAD_SHA,
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
      app: { id: TRUSTED_AUTHORIZATION_APP_IDS[0] },
    },
  };
  const authorizationInput = {
    authorization,
    prNumber: 138,
    headOid: HEAD_SHA,
    labels: [SAFE_LABELS[0]],
    timeline: {
      complete: true,
      items: [
        {
          event: 'committed',
          sha: HEAD_SHA,
        },
        {
          id: 12001,
          event: 'labeled',
          label: { name: SAFE_LABELS[0] },
          actor: { login: 'maintainer' },
          created_at: '2026-07-24T00:03:00Z',
        },
      ],
    },
    permission: {
      complete: true,
      login: 'maintainer',
      roleName: 'maintain',
    },
  };
  const authorizationEvidence = deriveLiveAuthorizationEvidence(authorizationInput);
  const authorizationBeforeHead = deriveLiveAuthorizationEvidence({
    ...authorizationInput,
    timeline: {
      complete: true,
      items: [...authorizationInput.timeline.items].reverse(),
    },
  });
  const authorizationBeforeForcePushBack = deriveLiveAuthorizationEvidence({
    ...authorizationInput,
    timeline: {
      complete: true,
      items: [
        { event: 'committed', sha: HEAD_SHA },
        { event: 'committed', sha: 'd'.repeat(40) },
        authorizationInput.timeline.items.at(-1),
        {
          event: 'head_ref_force_pushed',
          commit_id: HEAD_SHA,
          created_at: '2026-07-24T00:04:00Z',
        },
      ],
    },
  });
  const relabeledByLoop = deriveLiveAuthorizationEvidence({
    ...authorizationInput,
    timeline: {
      complete: true,
      items: [
        ...authorizationInput.timeline.items,
        {
          id: 12002,
          event: 'unlabeled',
          label: { name: SAFE_LABELS[0] },
          actor: { login: 'maintainer' },
          created_at: '2026-07-24T00:04:00Z',
        },
        {
          id: 12003,
          event: 'labeled',
          label: { name: SAFE_LABELS[0] },
          actor: { login: LOOP_LOGIN },
          created_at: '2026-07-24T00:05:00Z',
        },
      ],
    },
  });

  const branchProtection = {
    required_status_checks: {
      strict: true,
      contexts: requiredCheckContracts().map(({ name }) => name),
      checks: requiredCheckContracts().map(({ name, appIds }) => ({
        context: name,
        app_id: appIds[0],
      })),
    },
    enforce_admins: { enabled: true },
    required_pull_request_reviews: {
      dismiss_stale_reviews: true,
      require_code_owner_reviews: false,
      required_approving_review_count: 1,
      require_last_push_approval: true,
      bypass_pull_request_allowances: { users: [], teams: [], apps: [] },
    },
    required_conversation_resolution: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
  };
  const policyInput = {
    branchProtection: { complete: true, value: branchProtection },
    branchRules: { complete: true, items: [] },
    rulesets: { complete: true, items: [] },
  };
  const livePolicy = deriveLiveServerPolicy(policyInput);
  const unpinnedPolicy = deriveLiveServerPolicy({
    ...policyInput,
    branchProtection: {
      complete: true,
      value: {
        ...branchProtection,
        required_status_checks: {
          ...branchProtection.required_status_checks,
          checks: branchProtection.required_status_checks.checks.map((check, index) =>
            index === 0 ? { ...check, app_id: null } : check),
        },
      },
    },
  });
  const mismatchedCheckContexts = deriveLiveServerPolicy({
    ...policyInput,
    branchProtection: {
      complete: true,
      value: {
        ...branchProtection,
        required_status_checks: {
          ...branchProtection.required_status_checks,
          checks: branchProtection.required_status_checks.checks.map((check, index) =>
            index === 0
              ? { ...check, context: branchProtection.required_status_checks.checks[1].context }
              : check),
        },
      },
    },
  });
  const bypassRule = {
    type: 'pull_request',
    ruleset_id: 99,
    parameters: {
      dismiss_stale_reviews_on_push: true,
      require_code_owner_review: false,
      require_last_push_approval: true,
      required_approving_review_count: 1,
      required_review_thread_resolution: true,
    },
  };
  const bypassPolicy = deriveLiveServerPolicy({
    ...policyInput,
    branchRules: { complete: true, items: [bypassRule] },
    rulesets: {
      complete: true,
      items: [{
        id: 99,
        enforcement: 'active',
        bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }],
      }],
    },
  });
  const hiddenBypassPolicy = deriveLiveServerPolicy({
    ...policyInput,
    branchRules: { complete: true, items: [bypassRule] },
    rulesets: {
      complete: true,
      items: [{ id: 99, enforcement: 'active' }],
    },
  });

  return [
    {
      name: 'live issue provenance, dependencies, and frozen plan hydrate completely',
      ok:
        issueEvidence.linkedIssue.complete === true
        && issueEvidence.linkedIssue.dependenciesClear === true
        && issueEvidence.ownership.frozenPlanCommentVerified === true,
    },
    {
      name: 'current linked-issue hard label overrides stale policy claims',
      ok: hardLabelEvidence.linkedIssue.blocked === true,
    },
    {
      name: 'reopened dependency is not cleared by an exact-head attestation',
      ok: reopenedDependency.linkedIssue.dependenciesClear === false,
    },
    {
      name: 'deleted frozen-plan comment invalidates ownership',
      ok: deletedPlan.ownership.frozenPlanCommentVerified === false,
    },
    {
      name: 'edited frozen-plan comment invalidates ownership',
      ok: editedPlan.ownership.frozenPlanCommentVerified === false,
    },
    {
      name: 'empty frozen-plan comment cannot satisfy ownership',
      ok: emptyPlan.ownership.frozenPlanCommentVerified === false,
    },
    {
      name: 'incomplete issue timeline cannot prove eligibility',
      ok: incompleteTimeline.linkedIssue.complete === false,
    },
    {
      name: 'exact current Path A label event hydrates authorization',
      ok:
        authorizationEvidence.eventVerified === true
        && authorizationEvidence.afterCurrentHead === true,
    },
    {
      name: 'Path A label event older than the current head cannot hydrate authorization',
      ok:
        authorizationBeforeHead.eventVerified === true
        && authorizationBeforeHead.afterCurrentHead === false,
    },
    {
      name: 'Path A label before a force-push back to a historical head cannot hydrate authorization',
      ok:
        authorizationBeforeForcePushBack.eventVerified === true
        && authorizationBeforeForcePushBack.afterCurrentHead === false,
    },
    {
      name: 'label removal and loop re-add cannot reuse human authorization',
      ok: relabeledByLoop.eventVerified === false,
    },
    {
      name: 'API-shaped live branch protection derives strict pinned policy',
      ok:
        livePolicy.complete === true
        && livePolicy.strict === true
        && livePolicy.requiredChecks.length === requiredCheckContracts().length,
    },
    {
      name: 'un-pinned live required check makes server policy incomplete',
      ok: unpinnedPolicy.complete === false,
    },
    {
      name: 'mismatched live required-check contexts make server policy incomplete',
      ok: mismatchedCheckContexts.complete === false,
    },
    {
      name: 'applicable ruleset bypass allowance is detected',
      ok: bypassPolicy.actorCanBypass === true,
    },
    {
      name: 'hidden applicable ruleset bypass actors make policy incomplete',
      ok: hiddenBypassPolicy.complete === false,
    },
  ];
}

function selfTest() {
  let passed = 0;
  let failed = 0;
  for (const check of [
    ...statusStampCases(),
    ...restPaginationCases(),
    ...liveEvidenceCases(),
  ]) {
    if (check.ok) passed += 1;
    else failed += 1;
    console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}`);
  }
  for (const fixture of FIXTURES) {
    const calls = [];
    let confirmCalls = 0;
    const result = run(fixture.input, {
      dryRun: fixture.dryRun === true,
      mergeExecutor: (args) => {
        calls.push({ ...args });
        if (fixture.mergeBehavior === 'cas409') throw Object.assign(new Error('head changed before merge'), { status: 409 });
        if (fixture.mergeBehavior === 'identity') {
          throw Object.assign(new Error('executor identity mismatch'), {
            code: 'EXECUTOR_IDENTITY_MISMATCH',
          });
        }
        if (fixture.mergeBehavior === 'timeout') throw Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' });
        return { merged: true };
      },
      confirmMerged: () => {
        confirmCalls += 1;
        return fixture.confirmMerged ?? { merged: false, headSha: null };
      },
      sleep: () => {},
      strategy: fixture.strategy,
    });
    const expectedCalls = fixture.expectCalls ?? 0;
    const argsOkay = fixture.expectArgs ? JSON.stringify(calls[0]) === JSON.stringify(fixture.expectArgs) : true;
    const confirmOkay = fixture.expectConfirmCalls === undefined || confirmCalls === fixture.expectConfirmCalls;
    const ok = result.exitCode === fixture.expectExit && calls.length === expectedCalls && argsOkay && confirmOkay;
    if (ok) passed += 1;
    else failed += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${fixture.name}`);
    if (!ok) {
      console.log(`  expected exit=${fixture.expectExit}, calls=${expectedCalls}, confirms=${fixture.expectConfirmCalls ?? 'any'}`);
      console.log(`  actual   exit=${result.exitCode}, calls=${calls.length}, confirms=${confirmCalls}, reasons=${result.reasons.join('; ')}`);
    }
  }
  console.log(`self-test: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

function usage() {
  console.error('usage: node tools/agentic/auto-merge.mjs <prNumber> [--dry-run] | --self-test');
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--self-test') process.exit(selfTest() ? 0 : 1);

  const number = args.find((arg) => /^\d+$/.test(arg));
  const dryRun = args.includes('--dry-run');
  const validNormal = number && args.length <= 2 && args.every((arg) => arg === number || arg === '--dry-run');
  if (!validNormal || Number(number) < 1) {
    usage();
    process.exit(2);
  }

  const inputs = fetchInputs(Number(number));
  inputs.prNumber = Number(number);
  const result = run(inputs, { dryRun });
  const { decision } = result;

  console.log(`#${number}: path=${decision.path} allow=${decision.allow}`);
  if (dryRun && decision.allow) console.log(`WOULD-MERGE #${number} (squash, sha=${inputs.headRefOid}) — dry-run, not merging`);
  if (!decision.allow || result.exitCode !== 0) {
    console.log(`REFUSE #${number} — leave for human merge:`);
    for (const reason of result.reasons) console.log(`  - ${reason}`);
    process.exit(1);
  }
  if (!dryRun) {
    console.log(`MERGED #${number} (squash, sha=${inputs.headRefOid})`);
  }
  process.exit(0);
}

// realpath compare — the naive `file://` string check fails open on encoded paths and symlinks.
const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMain) main();
