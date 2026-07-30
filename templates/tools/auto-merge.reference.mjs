#!/usr/bin/env node
// ============================================================================
// NON-MANUAL MERGE REFERENCE — dormant by default, enabled only by recorded
// consent. Setup vendors this file as tools/agentic/auto-merge.mjs solely for a
// repository whose committed config carries merge.policy: ratified|auto WITH
// merge.unverifiedInvocationAcknowledged: true; Runtime opens such runs on that
// recorded acceptance and still rejects every unacknowledged non-manual run
// before probing or mutation. With the placeholder REPO CONFIG block below,
// every invocation refuses fail-closed; only autoloop:setup fills it.
//
// The policy ENGINE (independently fetched, SHA-bound evidence; AND-gate;
// kill-switch; CAS merge + confirmation) is identical in every mode.
// The self-test fixtures DERIVE from the config block, so `--self-test` stays
// meaningful for any filled config — run it after every config change.
//
// SOLO_OPERATOR transcribes the additional merge.soloOperatorAcknowledged: true
// consent for a single-identity repository: the one human IS the loop login,
// so identity separation and approving review are unsatisfiable there.
// Solo is the ONLY supported non-manual configuration — the merge gate refuses
// every non-solo config as retired (docs/specs/simple-delivery.md). Exact-head
// CAS merge, the triggered-checks floor, the verdict statuses, ownership
// binding, protected paths, and the kill switch keep full strength. No
// acknowledgement grants the loop tag, release, or base-branch authority, and
// provenance remains best-effort-unverified in every mode.
// ============================================================================
// Ratified/auto merge engine for the dev loop; reference-dormant until the
// acknowledgements above are committed.
//
// The policy is a pure AND-gate over independently fetched, SHA-bound GitHub
// evidence. Its own tools/** path is protected and can never be authorized by this
// file. These properties are verified as dormant reference behavior only.
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
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createPremergeRecord,
  premergeRecordHash,
  serializePremergeRecord,
  validPremergeRecordId,
} from './attestation-contract.mjs';
import { parseLoopClaim } from './claim-contract.mjs';
import { finalizeHead } from './delivery-contract.mjs';
import {
  lifecycleCommentNeverEdited,
  lifecycleIdentityHash,
  resolveLifecycleCommentChain,
  serializeLifecycleMarker,
} from './lifecycle-contract.mjs';
import { matchMergeProtected } from './lane-contract.mjs';
import { authorizeMerge } from './merge-authorization-contract.mjs';
import {
  authorizePolicyPublication,
  buildCommitStatus,
  fetchPublicationStatuses,
} from './publish-verdict.mjs';

// ── REPO CONFIG — filled by autoloop:setup; the vendored copy in your repo is the policy ──
export const REPOSITORY = { owner: 'your-org', name: 'your-repo' }; // setup: from `gh repo view`
export const BASE_BRANCH = 'main'; // setup: the loop's base branch
// There is no required-check list: the triggered-checks floor (every check run
// and commit status on the exact head green) plus the two verdict statuses are
// the whole CI predicate.
// Path B allowlist (globs): the reversible class that may auto-merge WITHOUT a human
// risk label. Docs-only is the safe generic default; widen only by explicit user choice.
// (Protected families below still veto — a reversible glob can never expose a protected path.)
export const REVERSIBLE_PATHS = ['docs/**'];
// Repo crown jewels beyond the generic structural families below. Setup mirrors
// STATE's escalate-list here (auth, secrets, schema, payments, external contracts, …).
export const EXTRA_PROTECTED_PATHS = [];
// Authorization mode. **DERIVED from the repository's committed `merge.policy`,
// never chosen independently of it** — setup writes `'all-green'` for
// `merge.policy: auto` and `'classified'` for `merge.policy: ratified`:
//   'classified' — only the reversible class auto-merges: Path A (human risk label)
//                  or Path B (REVERSIBLE_PATHS allowlist + ≤20 files / ≤700 lines).
//                  This is what `merge.policy: ratified` means.
//   'all-green'  — every loop PR auto-merges when ALL evidence is green (verdicts,
//                  CI, clean merge state, no unresolved threads) — EXCEPT the floor
//                  that never auto-merges in any mode: protected paths (structural +
//                  extra) and hard-block labels (human:authorize, do-not-merge, …).
//                  The mode widens the CLASS, never the floor. Without CI it rests
//                  on the loop's own verdicts alone — setup must refuse to write it
//                  unless the user explicitly accepts that in so many words.
//                  This is what `merge.policy: auto` means.
//
// The two must never disagree, because this constant is the only one the gate
// reads: `mergePolicy` below is computed from it, and the committed
// `merge.policy` is never consulted at runtime. A repository that answered `auto`
// and got `'classified'` written here has a config whose merge setting does
// nothing, and the refusal it produces cites a `ratified` policy the config never
// names — observed on a live repository, where the maintainer had set `auto`,
// every code PR was refused as unclassified, and nothing pointed at this line.
export const AUTOMERGE_MODE = 'classified';
export const LOOP_LOGIN = 'autoloop[bot]';
export const TRUSTED_HUMAN_LOGINS = ['maintainer'];
// Solo-operator installations have exactly one human, who necessarily shares the
// loop's login. Setup writes true ONLY from a config carrying BOTH acknowledgements
// (merge.unverifiedInvocationAcknowledged AND merge.soloOperatorAcknowledged) and
// then fills TRUSTED_HUMAN_LOGINS = [LOOP_LOGIN]. Non-solo is retired:
// authorizeMerge refuses any config without soloOperator=true, naming
// docs/specs/simple-delivery.md.
export const SOLO_OPERATOR = false;
// Solo default 0: GitHub forbids approving one's own PR, so a solo repository
// can never reach APPROVED.
export const REQUIRED_APPROVING_REVIEW_COUNT = 0;
export const REQUIRE_CODE_OWNER_REVIEWS = false;
export const BASE_FRESHNESS_STRATEGY = 'direct-strict';
// This is separately human-ratified merge authority, not a live read of ProjectConfig. New
// scaffolds align it with caps.sliceMaxLines, but changing either value never silently changes the
// other.
export const REVERSIBLE_MAX_LINES = 700;
// ── end repo config — everything below is the generic engine ──

// The two verdict COMMIT STATUSES the finalizer posts (success-only,
// SHA-bound, description carries the summary-hash prefix).
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
const SHA_RE = /^[0-9a-f]{40}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;
const HEAD_SHA = 'a'.repeat(40);
const BASE_SHA = 'e'.repeat(40);
const CLAIM_SHA = 'd'.repeat(40);
const LOOP_ISSUE = 7;
const ISSUE_BODY_HASH = 'b'.repeat(64);
const FROZEN_PLAN_HASH = 'c'.repeat(64);
const GH_API_HEADERS = [
  '-H',
  'Accept: application/vnd.github+json',
  '-H',
  'X-GitHub-Api-Version: 2026-03-10',
];

const CORE_QUERY = `
  query($owner:String!, $name:String!, $number:Int!) {
    repository(owner:$owner, name:$name) {
      pullRequest(number:$number) {
        state
        isDraft
        baseRefName
        baseRefOid
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
            createdAt
            updatedAt
            lastEditedAt
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
            createdAt
            updatedAt
            lastEditedAt
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
    baseRefOid: pr.baseRefOid,
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

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
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

// Discovery of the finalized delivery: the loop-authored lifecycle comment
// chain must resolve to a tip marker bound to the current head that carries
// the premerge-record identity. Everything the marker claims (record comment,
// verdict statuses, plan comment, delivery floor) is verified afterwards by
// authorizePolicyPublication — this function only locates the claim.
function finalizedDeliveryMarker(comments, loopLogin, headOid) {
  if (comments?.complete !== true || !Array.isArray(comments.items)) return null;
  let chain = null;
  try {
    chain = resolveLifecycleCommentChain(
      comments.items
        .filter((comment) =>
          typeof comment?.body === 'string'
          && comment.body.includes('autoloop-lifecycle-v1')
          && comment?.author?.login === loopLogin)
        .map((comment) => ({
          id: comment.id,
          body: comment.body,
          neverEdited: comment.neverEdited === true,
        })),
    );
  } catch {
    return null;
  }
  const marker = chain?.tip?.marker;
  return (
    marker
    && marker.headOid === headOid
    && validPremergeRecordId(marker.premergeRecord)
    && HASH_RE.test(marker.premergeRecordHash ?? '')
    && typeof marker.premergeRecordCommentId === 'string'
  )
    ? marker
    : null;
}

export function deriveLiveIssueEvidence(input) {
  const issue = input?.issue;
  const timeline = input?.timeline;
  const comments = input?.comments;
  const dependencies = input?.dependencies;
  const permission = input?.loopReadyPermission;
  const pullRequest = input?.pullRequest;
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
  const marker = finalizedDeliveryMarker(comments, input?.loopLogin, pullRequest?.headOid);
  const commitMetadata = Array.isArray(input?.commitMetadata)
    ? input.commitMetadata.map((commit) => ({
      oid: commit?.oid,
      message: commit?.message,
      parentOids: Array.isArray(commit?.parentOids) ? [...commit.parentOids] : commit?.parentOids,
    }))
    : null;
  // The marker's ownership facts (issue-body identity, claim commit, frozen
  // plan) are sealed into the premerge record via its lifecycle identity hash;
  // the claim ancestry itself is proven against live PR commit metadata.
  const ownership = marker === null ? null : {
    complete:
      SHA_RE.test(marker.claimCommit ?? '')
      && HASH_RE.test(marker.issueBodyHash ?? '')
      && HASH_RE.test(marker.planHash ?? '')
      && typeof marker.planCommentId === 'string'
      && marker.planCommentId.length > 0,
    issue: marker.issue,
    issueBodyHash: marker.issueBodyHash,
    claimCommitAncestor:
      Array.isArray(commitMetadata)
      && commitMetadata.some((commit) => commit.oid === marker.claimCommit),
    claimCommit: {
      complete: Array.isArray(commitMetadata),
      issue: marker.issue,
      headOid: marker.headOid,
      baseOid: pullRequest?.baseOid,
      oid: marker.claimCommit,
      commits: commitMetadata,
    },
    frozenPlanHash: marker.planHash,
    frozenPlanCommentId: marker.planCommentId ?? null,
    frozenPlanAuthor: input?.loopLogin,
  };
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
  const policyAttestation = marker === null ? null : {
    kind: 'policy',
    v: 1,
    headOid: marker.headOid,
    issue: marker.issue,
    pullRequest: marker.pr,
    delivered: true,
    premergeRecordId: marker.premergeRecord,
    premergeRecordHash: marker.premergeRecordHash,
    premergeRecordAuthor: input?.loopLogin,
  };
  const policyVerification = policyAttestation
    ? authorizePolicyPublication(policyAttestation, {
      complete: input?.policyLiveComplete === true,
      loopAuthor: input?.loopLogin,
      issue: { number: issue?.number },
      pullRequest,
      comments,
      statuses: input?.statuses,
      delivery: input?.delivery,
    })
    : null;
  const premergeObservation = policyVerification?.observation ?? null;
  const premergeVerified = (
    policyVerification?.authorized === true
    && premergeObservation?.verified === true
    && premergeObservation.pullRequest === policyAttestation?.pullRequest
    && issue?.number === policyAttestation?.issue
  );
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
    lifecycle: policyAttestation
      ? {
        complete:
          comments?.complete === true
          && input?.statuses?.complete === true
          && premergeObservation?.complete === true,
        delivered: policyAttestation.delivered,
        headOid: policyAttestation.headOid,
        premergeRecord: premergeVerified,
        premergeRecordId: premergeVerified ? premergeObservation.id : null,
        premergeRecordHash: premergeVerified ? premergeObservation.bodyHash : null,
        premergeRecordAuthor: premergeVerified ? premergeObservation.author : null,
        premergeRecordCommentId: premergeVerified ? premergeObservation.commentId : null,
        premergeRecordIssue: premergeVerified ? premergeObservation.issue : null,
        premergeRecordPullRequest:
          premergeVerified ? premergeObservation.pullRequest : null,
      }
      : null,
    // The verdict statuses matched the record's summary hashes byte-exactly
    // inside the premerge verification; that IS the typed exact-head gate
    // evidence in the status era.
    gateEvidenceVerified: premergeVerified === true,
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
        neverEdited: lifecycleCommentNeverEdited(comment),
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

function fetchLinkedIssueEvidence(number, policyLive) {
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
    ...policyLive,
    loopLogin: LOOP_LOGIN,
  });
}

// Path A evidence is the live label event itself: the seed is the latest
// labeled event for the PR's safe label, and deriveLiveAuthorizationEvidence
// proves head ordering and the actor's current permission on top of it.
function fetchLiveAuthorization(number, headOid, labels) {
  const label = SAFE_LABELS.find((candidate) => labels.includes(candidate));
  if (!label) return null;
  const timeline = fetchTimeline(number);
  const event = latestLabelEvent(timeline.items, label);
  if (event?.event !== 'labeled') return null;
  const permission = event.actor?.login
    ? fetchPermission(event.actor.login)
    : { complete: false, login: null, roleName: null };
  return deriveLiveAuthorizationEvidence({
    authorization: {
      complete: true,
      pullRequest: number,
      actor: event.actor?.login ?? null,
      headOid,
      label,
      labelEventId: event.id,
      labeledAt: event.created_at,
    },
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

export function collectPrCommitMetadata(pages) {
  const commits = [];
  const seen = new Set();
  for (const page of pages) {
    if (!Array.isArray(page)) throw new Error('PR commits page was not an array');
    for (const commit of page) {
      const oid = commit?.sha;
      const message = commit?.commit?.message;
      const parents = commit?.parents;
      if (
        !/^[0-9a-f]{40}$/i.test(oid ?? '')
        || typeof message !== 'string'
        || !Array.isArray(parents)
        || parents.length === 0
        || parents.some((parent) => !/^[0-9a-f]{40}$/i.test(parent?.sha ?? ''))
      ) {
        throw new Error('PR commits response contained invalid commit metadata');
      }
      const normalizedOid = oid.toLowerCase();
      if (seen.has(normalizedOid)) throw new Error('PR commits response repeated a commit OID');
      seen.add(normalizedOid);
      commits.push({
        oid: normalizedOid,
        message,
        parentOids: parents.map((parent) => parent.sha.toLowerCase()),
      });
    }
  }
  if (commits.length === 0) throw new Error('PR commits response was empty');
  if (commits.length >= 250) {
    throw new Error('PR commit provenance reached GitHub endpoint limit and may be truncated');
  }
  return commits;
}

function fetchPrCommitMetadata(number) {
  return collectPrCommitMetadata(
    ghPaginated(`repos/${REPO_SLUG}/pulls/${number}/commits?per_page=100`),
  );
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
    baseRefOid: null,
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
    gateEvidenceVerified: false,
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
  let commitMetadata = null;
  try {
    commitMetadata = fetchPrCommitMetadata(number);
  } catch (error) {
    inputs.fetchReasons.push(`PR commit provenance fetch failed: ${errorMessage(error)}`);
  }

  if (claim.valid) {
    let delivery = null;
    let verdictStatuses = null;
    if (inputs.headRefOid) {
      // Double-read latest-per-context statuses: the shape the premerge-record
      // verification compares against the record's summary hashes.
      try {
        verdictStatuses = fetchPublicationStatuses({
          host: 'github.com',
          owner: REPOSITORY.owner,
          repo: REPOSITORY.name,
        }, inputs.headRefOid);
      } catch (error) {
        inputs.fetchReasons.push(`verdict status fetch failed: ${errorMessage(error)}`);
      }
      try {
        delivery = finalizeHead({
          schemaVersion: 1,
          repository: `${REPOSITORY.owner}/${REPOSITORY.name}`,
          pullRequest: inputs.prNumber,
          committedHead: inputs.headRefOid,
          reviewedHead: inputs.headRefOid,
          gatedHead: inputs.headRefOid,
        });
        if (delivery.canMarkDelivered !== true) {
          inputs.fetchReasons.push(
            `live delivery evidence failed: ${delivery.code ?? 'DELIVERY_UNVERIFIED'}`,
          );
        }
      } catch (error) {
        inputs.fetchReasons.push(
          `live delivery evidence failed closed: ${errorMessage(error)}`,
        );
      }
    }
    try {
      const issueEvidence = fetchLinkedIssueEvidence(claim.issue, {
        policyLiveComplete:
          inputs.coreComplete === true
          && inputs.rollupComplete === true
          && verdictStatuses?.complete === true,
        pullRequest: {
          number: inputs.prNumber,
          headOid: inputs.headRefOid,
          headRefName: inputs.headRefName,
          body: inputs.body,
          merged: upper(inputs.state) === 'MERGED',
          mergeOid: null,
          baseOid: inputs.baseRefOid,
        },
        commitMetadata,
        statuses: verdictStatuses,
        delivery,
      });
      inputs.linkedIssue = issueEvidence.linkedIssue;
      inputs.ownership = issueEvidence.ownership;
      inputs.lifecycle = issueEvidence.lifecycle;
      inputs.gateEvidenceVerified = issueEvidence.gateEvidenceVerified === true;
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

// The vendored REPO CONFIG block transcribed into the gate's config shape.
// Self-test fixtures override toward the solo shape (the only one the gate
// accepts); the live path always uses the vendored constants.
export function engineConfig(overrides = {}) {
  return {
    repository: REPOSITORY,
    baseBranch: BASE_BRANCH,
    mergePolicy: AUTOMERGE_MODE === 'all-green' ? 'auto' : 'ratified',
    baseFreshnessStrategy: BASE_FRESHNESS_STRATEGY,
    loopLogin: LOOP_LOGIN,
    trustedHumanLogins: TRUSTED_HUMAN_LOGINS,
    soloOperator: SOLO_OPERATOR,
    requiredApprovingReviewCount: REQUIRED_APPROVING_REVIEW_COUNT,
    requireCodeOwnerReviews: REQUIRE_CODE_OWNER_REVIEWS,
    ...overrides,
  };
}

function mergeAuthorizationInput(pr, path, config) {
  const claim = parseLoopClaim({ branch: pr.headRefName, body: pr.body });
  const statuses = Array.isArray(pr.statuses) ? pr.statuses : null;
  return {
    config,
    pr: {
      number: pr.prNumber,
      complete: pr.coreComplete === true,
      state: upper(pr.state),
      isDraft: pr.isDraft,
      baseRefName: pr.baseRefName,
      baseRefOid: pr.baseRefOid,
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
      gateEvidenceVerified: pr.gateEvidenceVerified,
      path,
      authorization: pr.authorization,
      checks: Array.isArray(pr.checkRuns) ? pr.checkRuns.map(normalizedCheckRun) : null,
      checksComplete: pr.rollupComplete === true,
      // Latest status per context, exact-head only: the combined-status fetch
      // stamps each item with the page sha, so any stray sha fails closed.
      statuses: {
        complete:
          pr.rollupComplete === true
          && statuses !== null
          && statuses.every((status) => status.sha === pr.headRefOid),
        items: (statuses ?? []).map((status) => ({
          context: status.context,
          state: status.state,
          description: status.description ?? '',
        })),
      },
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
  };
}

/**
 * Pure policy decision. Signal collection, pagination, and merge execution are all
 * outside this function so fixtures can drive the complete orchestration without a network.
 *
 * @returns {{allow:boolean, reasons:string[], path:'A'|'B'|'all-green'|'none'}}
 */
export function decide(pr, config = engineConfig()) {
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
  for (const status of statuses) {
    if (status.sha !== headRefOid) reasons.push(`status context ${status.context ?? 'unknown'} is not on fetched headRefOid`);
  }

  const checkRuns = Array.isArray(pr.checkRuns) ? pr.checkRuns : [];
  // Triggered-checks floor: whatever actually ran on the head must be green —
  // no pending runs, no failures, no required-name list. A repo without CI has
  // nothing on the head and passes vacuously; this floor still protects every
  // PR that DID trigger checks. A concluded run with no `status` field counts
  // as completed (self-test fixtures and older API shapes omit it).
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
  // The floor covers commit statuses too, verdict contexts included; the
  // verdict statuses' presence and record binding are enforced by the merge
  // authorization contract and the premerge verification.
  for (const status of statuses) {
    if (status.sha !== headRefOid) continue;
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
  const pathBSize = hasKnownSize
    && pr.changedFiles <= 20
    && pr.additions + pr.deletions <= REVERSIBLE_MAX_LINES;
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
          if (pr.additions + pr.deletions > REVERSIBLE_MAX_LINES) reasons.push(`not authorized: Path B has too many changed lines (${pr.additions + pr.deletions} > ${REVERSIBLE_MAX_LINES})`);
        }
      }
    }
  }

  const authorization = authorizeMerge(mergeAuthorizationInput(pr, path, config));
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
  config = engineConfig(),
} = {}) {
  const decision = decide(inputs, config);
  const result = { exitCode: decision.allow ? 0 : 1, decision, reasons: [...decision.reasons] };
  if (!decision.allow) return result;

  if (strategy !== BASE_FRESHNESS_STRATEGY || strategy !== 'direct-strict') {
    result.exitCode = 1;
    result.reasons.push(
      `unsupported submission strategy: ${strategy}; direct-strict is the only supported strategy`,
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
// filled config, with one forced override: authorizeMerge accepts only the solo
// shape, so fixture runs use SELF_TEST_CONFIG (solo over the vendored block) and
// a dedicated fixture pins the non-solo refusal.
// pathFromGlob turns the first glob of a list into a concrete path.
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
const SELF_TEST_CONFIG = engineConfig({
  soloOperator: true,
  trustedHumanLogins: [LOOP_LOGIN],
  requiredApprovingReviewCount: 0,
});

function makeCheckRuns() {
  return [{
    name: 'ci-build',
    status: 'completed',
    conclusion: 'success',
    head_sha: HEAD_SHA,
    app: { id: 15368, slug: 'github-actions', name: 'GitHub Actions' },
  }];
}

function makeVerdictStatuses() {
  return REQUIRED_VERDICTS.map((context) => ({
    ...buildCommitStatus(context.slice('agentic/'.length), HEAD_SHA, '0'.repeat(64)),
    sha: HEAD_SHA,
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
    baseRefOid: BASE_SHA,
    headRefName,
    body,
    headRefOid: HEAD_SHA,
    headRepository: { owner: REPOSITORY.owner, name: REPOSITORY.name },
    labels: [...new Set(labels)],
    changedFiles: entries.length,
    additions: 10,
    deletions: 5,
    // A solo repository can never reach APPROVED (GitHub forbids self-approval).
    reviewDecision: null,
    reviewRequests: [],
    reviewRequestsComplete: true,
    mergeStateStatus: 'CLEAN',
    fileEntries: entries,
    filePaginationComplete: true,
    reviewThreads: [],
    threadPaginationComplete: true,
    statuses: makeVerdictStatuses(),
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
        // Solo semantics: the loop-ready actor is the one (loop) login.
        actor: LOOP_LOGIN,
        labeledAt: '2026-07-24T00:02:00Z',
        roleName: 'maintain',
      },
    },
    ownership: {
      complete: true,
      issueBodyHash: ISSUE_BODY_HASH,
      claimCommitAncestor: true,
      claimCommit: {
        complete: true,
        issue: LOOP_ISSUE,
        headOid: HEAD_SHA,
        baseOid: BASE_SHA,
        oid: CLAIM_SHA,
        commits: [
          {
            oid: CLAIM_SHA,
            message: `chore: claim #${LOOP_ISSUE}`,
            parentOids: [BASE_SHA],
          },
          {
            oid: HEAD_SHA,
            message: 'feat: implement safe change',
            parentOids: [CLAIM_SHA],
          },
        ],
      },
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
      premergeRecordId: `pmr_${'9'.repeat(64)}`,
      premergeRecordHash: '8'.repeat(64),
      premergeRecordAuthor: LOOP_LOGIN,
      premergeRecordCommentId: 'IC_premerge',
      premergeRecordIssue: LOOP_ISSUE,
      premergeRecordPullRequest: 138,
    },
    gateEvidenceVerified: true,
    // Solo self-authorization: the actor is the loop login; the label event,
    // head ordering, and current role are the whole Path-A evidence.
    authorization: {
      complete: true,
      pullRequest: 138,
      actor: LOOP_LOGIN,
      headOid: HEAD_SHA,
      label: labels.find((label) => SAFE_LABELS.includes(label)) ?? SAFE_LABELS[0],
      labelEventId: 12001,
      labeledAt: '2026-07-24T00:03:00Z',
      eventVerified: true,
      afterCurrentHead: true,
      roleName: 'maintain',
    },
    executorIdentity: {
      complete: true,
      login: LOOP_LOGIN,
      id: 9001,
    },
    fetchReasons: [],
    ...overrides,
  };
}

function protectedFixture(name, path) {
  return { name, input: makeInput({ files: [path], labels: ['risk:pure-deletion'] }), expectExit: 1, expectCalls: 0 };
}

function invalidClaimFixture(name, mutate) {
  const input = makeInput();
  input.ownership.claimCommit = mutate(input.ownership.claimCommit);
  return { name, input, expectExit: 1, expectCalls: 0 };
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
    name: 'missing agentic/gate verdict status on Path A',
    input: makeInput({
      labels: ['risk:pure-deletion'],
      statuses: makeVerdictStatuses().filter((status) => status.context !== 'agentic/gate'),
    }),
    expectExit: 1,
    expectCalls: 0,
  },
  {
    name: 'green verdict statuses without typed gate evidence block',
    input: makeInput({ gateEvidenceVerified: false }),
    expectExit: 1,
    expectCalls: 0,
  },
  {
    name: 'failing agentic/review verdict status on Path A',
    input: makeInput({
      labels: ['risk:pure-deletion'],
      statuses: makeVerdictStatuses().map((status) =>
        status.context === 'agentic/review' ? { ...status, state: 'failure' } : status),
    }),
    expectExit: 1,
    expectCalls: 0,
  },
  {
    name: 'missing agentic/review verdict status on Path B',
    input: makeInput({
      statuses: makeVerdictStatuses().filter((status) => status.context !== 'agentic/review'),
    }),
    expectExit: 1,
    expectCalls: 0,
  },
  {
    name: 'pending verdict status blocks',
    input: makeInput({
      statuses: makeVerdictStatuses().map((status) =>
        status.context === 'agentic/gate' ? { ...status, state: 'pending' } : status),
    }),
    expectExit: 1,
    expectCalls: 0,
  },
  // No configured agentic CheckRuns exist anymore: an agentic-named CheckRun
  // on the head is just another triggered check under the floor.
  {
    name: 'a green agentic-named CheckRun rides the triggered floor',
    input: makeInput({
      checkRuns: [
        ...makeCheckRuns(),
        {
          name: 'agentic/extra',
          status: 'completed',
          conclusion: 'success',
          head_sha: HEAD_SHA,
          app: { id: 999, slug: 'anything' },
        },
      ],
    }),
    expectExit: 0,
    expectCalls: 1,
  },
  {
    name: 'a red agentic-named CheckRun blocks like any triggered check',
    input: makeInput({
      checkRuns: [
        ...makeCheckRuns(),
        {
          name: 'agentic/extra',
          status: 'completed',
          conclusion: 'failure',
          head_sha: HEAD_SHA,
          app: { id: 999, slug: 'anything' },
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
  invalidClaimFixture('claim commit later in the PR blocks', (claimCommit) => ({
    ...claimCommit,
    commits: [...claimCommit.commits].reverse(),
  })),
  invalidClaimFixture('claim commit with a non-canonical message blocks', (claimCommit) => ({
    ...claimCommit,
    commits: claimCommit.commits.map((commit, index) =>
      index === 0 ? { ...commit, message: 'chore: claim issue 7' } : commit),
  })),
  invalidClaimFixture('claim commit parent not equal to base blocks', (claimCommit) => ({
    ...claimCommit,
    commits: claimCommit.commits.map((commit, index) =>
      index === 0 ? { ...commit, parentOids: ['f'.repeat(40)] } : commit),
  })),
  {
    name: 'missing linked issue and ownership evidence blocks',
    input: makeInput({ linkedIssue: null, ownership: null }),
    expectExit: 1,
    expectCalls: 0,
  },
  {
    name: 'solo dry-run would-merge posts nothing',
    input: makeInput(),
    dryRun: true,
    expectExit: 0,
    expectCalls: 0,
  },
  // The gate accepts only the solo shape; any other config is a typed refusal
  // naming docs/specs/simple-delivery.md.
  {
    name: 'non-solo config is refused as retired',
    input: makeInput(),
    config: engineConfig({ soloOperator: false }),
    expectExit: 1,
    expectCalls: 0,
  },
  {
    name: 'a status on a different sha than the fetched head blocks',
    input: makeInput({
      statuses: makeVerdictStatuses().map((status) =>
        status.context === 'agentic/gate' ? { ...status, sha: 'f'.repeat(40) } : status),
    }),
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
  // Triggered-checks floor: whatever ran on the head must be green.
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
  protectedFixture('protected credential storage', 'config/credentials.yml'),
  protectedFixture('protected private key material', 'certs/private-key.pem'),
  protectedFixture('protected nested .env file', 'apps/web/.env.local'),
  protectedFixture('protected CI requirements policy', '.autoloop/ci-policy.json'),
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
  protectedFixture('protected docker-compose.yaml', 'docker-compose.yaml'),
  protectedFixture('protected nested docker-compose', 'deploy/docker-compose.prod.yml'),
  protectedFixture('protected Dockerfile*', 'Dockerfile.prod'),
  protectedFixture('protected nested Dockerfile*', 'containers/Dockerfile.prod'),
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
    name: `${REVERSIBLE_MAX_LINES + 1} changed lines (size cap applies only to classified mode: ${AUTOMERGE_MODE})`,
    input: makeInput({ additions: Math.ceil((REVERSIBLE_MAX_LINES + 1) / 2), deletions: Math.floor((REVERSIBLE_MAX_LINES + 1) / 2) }),
    expectExit: ALLOW_ALL ? 0 : 1,
    expectCalls: ALLOW_ALL ? 1 : 0,
  },
  {
    name: `boundary exactly 20 files and exactly ${REVERSIBLE_MAX_LINES} lines → allow`,
    input: makeInput({
      files: Array.from({ length: 20 }, (_, index) => allowedPathN(100 + index)),
      additions: Math.ceil(REVERSIBLE_MAX_LINES / 2),
      deletions: Math.floor(REVERSIBLE_MAX_LINES / 2),
    }),
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
  // ── Premerge verification path: a bound lifecycle marker chain, the record
  // comment, the two verdict statuses, and the delivery floor — hydrated via
  // deriveLiveIssueEvidence exactly as the live path does.
  const base = makeInput();
  const planBody = 'frozen reviewed plan';
  const reviewSummaryValue =
    `Authenticated review convergence: REVIEW_CLEAN; round 2; receipt ${'2'.repeat(64)}.`;
  const gateSummaryValue = 'gate verdict summary';
  const deliveryFingerprint = sha256('delivery evidence fingerprint');
  const readyMarker = {
    v: 1,
    issue: LOOP_ISSUE,
    issueBodyHash: ISSUE_BODY_HASH,
    planHash: sha256(planBody),
    branch: base.headRefName,
    plannedBaseOid: BASE_SHA,
    selector: 'native',
    runIntentHash: '1'.repeat(64),
    intentSource: 'invocation',
    mergePolicy: 'ratified',
    phase: 'ready-head',
    claimCommit: CLAIM_SHA,
    pr: 138,
    epoch: 1,
    planCommentId: 'IC_kwDOAutoloop7',
    headOid: HEAD_SHA,
  };
  const record = createPremergeRecord({
    issue: LOOP_ISSUE,
    pullRequest: 138,
    headOid: HEAD_SHA,
    run: { intentHash: readyMarker.runIntentHash, receiptFingerprint: '2'.repeat(64) },
    plan: { commentId: readyMarker.planCommentId, contentHash: readyMarker.planHash },
    review: { summaryHash: sha256(reviewSummaryValue) },
    gate: { summaryHash: sha256(gateSummaryValue) },
    // The finalizer seals the triggered-floor observation fingerprint here.
    ci: { evidenceHash: deliveryFingerprint },
    lifecycle: { commentId: 'IC_lifecycle', identityHash: lifecycleIdentityHash(readyMarker) },
  });
  const boundMarker = {
    ...readyMarker,
    phase: 'premerge-record',
    premergeRecord: record.recordId,
    premergeRecordHash: premergeRecordHash(record),
    premergeRecordCommentId: 'IC_premerge',
  };
  const lifecycleBody = serializeLifecycleMarker(boundMarker);
  const delivery = {
    state: 'delivered',
    code: 'CI_GREEN',
    canMarkDelivered: true,
    headOid: HEAD_SHA,
    liveEvidence: {
      schemaVersion: 2,
      source: 'github-rest',
      repository: REPO_SLUG,
      pullRequest: 138,
      remoteHead: HEAD_SHA,
      baseRefName: BASE_BRANCH,
      draft: false,
      checks: [],
      statuses: [],
      provenance: {
        schemaVersion: 2,
        source: 'github-rest',
        repository: REPO_SLUG,
        pullRequest: 138,
        evidenceFingerprint: deliveryFingerprint,
      },
    },
  };
  const publicationStatuses = {
    complete: true,
    items: [
      buildCommitStatus('gate', HEAD_SHA, record.gate.summaryHash),
      buildCommitStatus('review', HEAD_SHA, record.review.summaryHash),
    ],
  };
  const commitMetadata = [
    { oid: CLAIM_SHA, message: `chore: claim #${LOOP_ISSUE}`, parentOids: [BASE_SHA] },
    { oid: HEAD_SHA, message: 'feat: implement safe change', parentOids: [CLAIM_SHA] },
  ];
  const comments = {
    complete: true,
    items: [
      { id: 'IC_kwDOAutoloop7', author: { login: LOOP_LOGIN }, body: planBody, neverEdited: true },
      { id: 'IC_lifecycle', author: { login: LOOP_LOGIN }, body: lifecycleBody, neverEdited: true },
      { id: 'IC_premerge', author: { login: LOOP_LOGIN }, body: serializePremergeRecord(record), neverEdited: true },
    ],
  };
  const policyLiveInput = {
    issue: { number: LOOP_ISSUE, labels: [] },
    comments,
    policyLiveComplete: true,
    pullRequest: {
      number: 138,
      headOid: HEAD_SHA,
      headRefName: base.headRefName,
      body: base.body,
      merged: false,
      mergeOid: null,
      baseOid: BASE_SHA,
    },
    commitMetadata,
    statuses: publicationStatuses,
    delivery,
    loopLogin: LOOP_LOGIN,
  };
  const hydrated = deriveLiveIssueEvidence(policyLiveInput);
  cases.push({
    name: 'a bound marker chain hydrates ownership, premerge record, and gate evidence',
    ok:
      hydrated.ownership?.claimCommitAncestor === true
      && hydrated.ownership?.claimCommit?.commits?.[0]?.message === `chore: claim #${LOOP_ISSUE}`
      && hydrated.ownership?.claimCommit?.baseOid === BASE_SHA
      && hydrated.ownership?.claimCommit?.headOid === HEAD_SHA
      && hydrated.ownership?.frozenPlanCommentVerified === true
      && hydrated.lifecycle?.complete === true
      && hydrated.lifecycle?.premergeRecord === true
      && hydrated.lifecycle?.premergeRecordId === record.recordId
      && hydrated.gateEvidenceVerified === true,
  });
  const missingReviewStatus = deriveLiveIssueEvidence({
    ...policyLiveInput,
    statuses: {
      complete: true,
      items: publicationStatuses.items.filter((status) => status.context !== 'agentic/review'),
    },
  });
  cases.push({
    name: 'a missing verdict status fails premerge verification',
    ok:
      missingReviewStatus.lifecycle?.complete === true
      && missingReviewStatus.lifecycle.premergeRecord === false,
  });
  const tamperedGateStatus = deriveLiveIssueEvidence({
    ...policyLiveInput,
    statuses: {
      complete: true,
      items: [
        buildCommitStatus('gate', HEAD_SHA, sha256('a different gate summary')),
        buildCommitStatus('review', HEAD_SHA, record.review.summaryHash),
      ],
    },
  });
  cases.push({
    name: 'a verdict status not matching the record summary hash fails closed',
    ok:
      tamperedGateStatus.lifecycle?.premergeRecord === false
      && tamperedGateStatus.gateEvidenceVerified === false,
  });
  const missingRecordComment = deriveLiveIssueEvidence({
    ...policyLiveInput,
    comments: {
      complete: true,
      items: comments.items.filter((comment) => comment.id !== 'IC_premerge'),
    },
  });
  cases.push({
    name: 'a marker bound to an absent record comment cannot hydrate lifecycle truth',
    ok:
      missingRecordComment.lifecycle?.complete === true
      && missingRecordComment.lifecycle.premergeRecord === false,
  });
  const staleMarker = deriveLiveIssueEvidence({
    ...policyLiveInput,
    pullRequest: { ...policyLiveInput.pullRequest, headOid: 'f'.repeat(40) },
  });
  cases.push({
    name: 'a marker for a stale head hydrates neither ownership nor lifecycle',
    ok: staleMarker.ownership === null && staleMarker.lifecycle === null,
  });
  const foreignMarker = deriveLiveIssueEvidence({
    ...policyLiveInput,
    comments: {
      complete: true,
      items: comments.items.map((comment) =>
        comment.id === 'IC_lifecycle' ? { ...comment, author: { login: 'someone-else' } } : comment),
    },
  });
  cases.push({
    name: 'a non-loop-authored marker chain cannot hydrate delivery evidence',
    ok: foreignMarker.ownership === null && foreignMarker.lifecycle === null,
  });
  const editedMarker = deriveLiveIssueEvidence({
    ...policyLiveInput,
    comments: {
      complete: true,
      items: comments.items.map((comment) =>
        comment.id === 'IC_lifecycle' ? { ...comment, neverEdited: false } : comment),
    },
  });
  cases.push({
    name: 'an edited marker root cannot hydrate delivery evidence',
    ok: editedMarker.ownership === null && editedMarker.lifecycle === null,
  });
  return cases;
}

function prCommitMetadataCases() {
  const first = {
    sha: CLAIM_SHA,
    commit: { message: `chore: claim #${LOOP_ISSUE}` },
    parents: [{ sha: BASE_SHA }],
  };
  const last = {
    sha: HEAD_SHA,
    commit: { message: 'feat: implement safe change' },
    parents: [{ sha: CLAIM_SHA }],
  };
  const normalized = collectPrCommitMetadata([[first], [last]]);
  let malformedRejected = false;
  try {
    collectPrCommitMetadata([[{ ...first, parents: [] }]]);
  } catch {
    malformedRejected = true;
  }
  let duplicateRejected = false;
  try {
    collectPrCommitMetadata([[first, first]]);
  } catch {
    duplicateRejected = true;
  }
  let endpointLimitRejected = false;
  try {
    collectPrCommitMetadata([Array.from({ length: 250 }, (_, index) => ({
      sha: index.toString(16).padStart(40, '0'),
      commit: { message: `commit ${index}` },
      parents: [{ sha: BASE_SHA }],
    }))]);
  } catch {
    endpointLimitRejected = true;
  }
  return [
    {
      name: 'PR commit metadata preserves API order and parents',
      ok:
        normalized[0]?.oid === CLAIM_SHA
        && normalized[0]?.parentOids?.[0] === BASE_SHA
        && normalized.at(-1)?.oid === HEAD_SHA,
    },
    {
      name: 'PR commit metadata rejects missing parents',
      ok: malformedRejected,
    },
    {
      name: 'PR commit metadata rejects duplicate OIDs',
      ok: duplicateRejected,
    },
    {
      name: 'PR commit metadata rejects the potentially truncated endpoint limit',
      ok: endpointLimitRejected,
    },
  ];
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
  // A finalized (bound) marker is the live source of ownership facts; the
  // record identity here is a placeholder — these cases exercise linked-issue
  // and frozen-plan hydration, not premerge verification.
  const liveMarker = (planHash) => ({
    v: 1,
    issue: LOOP_ISSUE,
    issueBodyHash: ISSUE_BODY_HASH,
    planHash,
    branch: `feat/gh-${LOOP_ISSUE}-safe-change`,
    plannedBaseOid: BASE_SHA,
    selector: 'native',
    runIntentHash: '1'.repeat(64),
    intentSource: 'invocation',
    mergePolicy: 'ratified',
    phase: 'premerge-record',
    claimCommit: CLAIM_SHA,
    pr: 138,
    epoch: 1,
    planCommentId: 'IC_kwDOAutoloop7',
    headOid: HEAD_SHA,
    premergeRecord: `pmr_${'9'.repeat(64)}`,
    premergeRecordHash: '8'.repeat(64),
    premergeRecordCommentId: 'IC_premerge',
  });
  const liveComments = (planHash, planBody) => ({
    complete: true,
    items: [
      {
        id: 'IC_kwDOAutoloop7',
        author: { login: LOOP_LOGIN },
        body: planBody,
      },
      {
        id: 'IC_live_marker',
        author: { login: LOOP_LOGIN },
        body: serializeLifecycleMarker(liveMarker(planHash)),
        neverEdited: true,
      },
    ],
  });
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
    comments: liveComments(sha256('frozen plan'), 'frozen plan'),
    dependencies: {
      complete: true,
      items: [{ number: 6, state: 'CLOSED' }],
    },
    loopReadyPermission: {
      complete: true,
      login: 'maintainer',
      roleName: 'maintain',
    },
    pullRequest: {
      number: 138,
      headOid: HEAD_SHA,
      headRefName: `feat/gh-${LOOP_ISSUE}-safe-change`,
      body: `Closes #${LOOP_ISSUE}`,
      merged: false,
      mergeOid: null,
      baseOid: BASE_SHA,
    },
    commitMetadata: [
      { oid: CLAIM_SHA, message: `chore: claim #${LOOP_ISSUE}`, parentOids: [BASE_SHA] },
      { oid: HEAD_SHA, message: 'feat: implement safe change', parentOids: [CLAIM_SHA] },
    ],
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
    comments: {
      complete: true,
      items: issueInput.comments.items.filter((comment) => comment.id !== 'IC_kwDOAutoloop7'),
    },
  });
  const editedPlan = deriveLiveIssueEvidence({
    ...issueInput,
    comments: {
      complete: true,
      items: issueInput.comments.items.map((comment) =>
        comment.id === 'IC_kwDOAutoloop7' ? { ...comment, body: 'edited frozen plan' } : comment),
    },
  });
  const emptyPlan = deriveLiveIssueEvidence({
    ...issueInput,
    comments: liveComments(sha256(''), ''),
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
  ];
}

// Solo semantics live in merge-authorization-contract.mjs and are fully
// fixture-proven there; the engine's whole solo responsibility is transcribing
// the vendored SOLO_OPERATOR constant into the gate config and refusing the
// retired non-solo shape.
function soloTranscriptionCases() {
  // Contract lint deliberately skips auto-merge.* (fixture prose would trip its
  // patterns), so the file polices its own header: the enablement claim must
  // state the acknowledgement conditional, never an unconditional refusal.
  const header = readFileSync(fileURLToPath(import.meta.url), 'utf8').slice(0, 2200);
  const nonSolo = authorizeMerge({
    config: engineConfig({ soloOperator: false }),
    pr: makeInput(),
  });
  return [
    {
      name: 'header states the acknowledged enablement conditional',
      ok: !/never installs or invokes/u.test(header)
        && header.includes('merge.unverifiedInvocationAcknowledged')
        && header.includes('merge.soloOperatorAcknowledged'),
    },
    {
      name: 'gate config transcribes SOLO_OPERATOR from the repo block',
      ok: engineConfig().soloOperator === SOLO_OPERATOR,
    },
    {
      name: 'non-solo authorization is a typed refusal naming the spec',
      ok: nonSolo.allow === false
        && nonSolo.reasons.some((reason) => reason.includes('docs/specs/simple-delivery.md')),
    },
  ];
}

function selfTest() {
  let passed = 0;
  let failed = 0;
  for (const check of [
    ...statusStampCases(),
    ...prCommitMetadataCases(),
    ...restPaginationCases(),
    ...liveEvidenceCases(),
    ...soloTranscriptionCases(),
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
      // authorizeMerge accepts only the solo shape, so fixtures run under the
      // solo override unless the fixture pins a config of its own.
      config: fixture.config ?? SELF_TEST_CONFIG,
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
