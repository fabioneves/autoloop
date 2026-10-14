#!/usr/bin/env node

import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGitHubRemote } from './checkout-contract.mjs';
import { readGitStatus } from './git-observation.mjs';
import { CLAIM_CONTRACT_FIXTURES, parseLoopClaim } from './claim-contract.mjs';
import { parseRepair } from './unit.mjs';
import {
  lifecycleCommentNeverEdited,
  parseLifecycleComment,
  resolveLifecycleCommentChain,
  serializeLifecycleSuccessor,
} from './lifecycle-contract.mjs';
import {
  SNAPSHOT_SECTIONS,
  blockedByIssueNumbers,
  collectPaginated,
  combineSections,
  completeSection,
  createLimiter,
  createSnapshot,
  incompleteSection,
  issueSnapshotItem,
  lifecycleMarkerSnapshotItem,
  mapBounded,
  verifySnapshot,
  writeStdoutSync,
} from './snapshot-contract.mjs';

const MAX_PAGES = 100;
const MAX_ITEMS = 10000;
const MAX_CONCURRENCY = 4;
const ROLE_PERMISSIONS = new Set(['admin', 'none', 'read', 'write']);
const TRUSTED_LIFECYCLE_ROLES = new Set(['admin', 'maintain']);

const ISSUES_QUERY = `
query($owner:String!,$name:String!,$cursor:String){
  repository(owner:$owner,name:$name){
    issues(states:OPEN,first:100,after:$cursor,orderBy:{field:UPDATED_AT,direction:DESC}){
      nodes{
        id number title body updatedAt lastEditedAt
        labels(first:100){nodes{name} pageInfo{hasNextPage endCursor}}
      }
      pageInfo{hasNextPage endCursor}
    }
  }
}`;

const ISSUE_LABELS_QUERY = `
query($id:ID!,$cursor:String){
  node(id:$id){
    ... on Issue{
      labels(first:100,after:$cursor){nodes{name} pageInfo{hasNextPage endCursor}}
    }
  }
}`;

const REPAIR_FACTS_QUERY = `
query($owner:String!,$name:String!,$number:Int!,$parent:Int!){
  repository(owner:$owner,name:$name){
    repair: issue(number:$number){id viewerDidAuthor}
    parent: issue(number:$parent){id state stateReason lastEditedAt labels(first:100){nodes{name}}}
  }
}`;

// The single-issue queries and the batched aliases share these selections, so a
// batched first page and a continuation page can never disagree on shape.
const DEPENDENCY_FIELDS = '__typename number state';
const COMMENT_CONNECTION = 'nodes{id author{login} authorAssociation body createdAt '
  + 'lastEditedAt updatedAt url viewerDidAuthor} pageInfo{hasNextPage endCursor}';
const LABEL_EVENT_FIELDS = 'id actor{login} createdAt label{name}';
const TIMELINE_CONNECTION = `nodes{__typename ... on LabeledEvent{${LABEL_EVENT_FIELDS}} `
  + `... on UnlabeledEvent{${LABEL_EVENT_FIELDS}}} pageInfo{hasNextPage endCursor}`;
const TIMELINE_TYPES = 'itemTypes:[LABELED_EVENT,UNLABELED_EVENT]';

const DEPENDENCY_ISSUE_QUERY = `
query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){issue(number:$number){${DEPENDENCY_FIELDS}}}
}`;

const ISSUE_COMMENTS_QUERY = `
query($owner:String!,$name:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$name){
    issue(number:$number){comments(first:100,after:$cursor){${COMMENT_CONNECTION}}}
  }
}`;

const ISSUE_TIMELINE_QUERY = `
query($owner:String!,$name:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$name){
    issue(number:$number){timelineItems(first:100,after:$cursor,${TIMELINE_TYPES}){${TIMELINE_CONNECTION}}}
  }
}`;

const ISSUE_BATCH_SIZE = 25;
const ISSUE_BATCH_FIELDS = Object.freeze({
  comments: `comments(first:100){${COMMENT_CONNECTION}}`,
  timeline: `timelineItems(first:100,${TIMELINE_TYPES}){${TIMELINE_CONNECTION}}`,
  dependency: DEPENDENCY_FIELDS,
});

const PULL_REQUESTS_QUERY = `
query($owner:String!,$name:String!,$states:[PullRequestState!],$cursor:String){
  repository(owner:$owner,name:$name){
    pullRequests(states:$states,first:100,after:$cursor,orderBy:{field:UPDATED_AT,direction:DESC}){
      nodes{
        id number title body isDraft reviewDecision headRefName headRefOid
        baseRefName mergeStateStatus mergeable mergedAt updatedAt
        author{login} headRepository{nameWithOwner}
        files(first:100){nodes{path}pageInfo{hasNextPage endCursor}}
        commits(last:1){
          nodes{
            commit{
              oid
              statusCheckRollup{
                state
                contexts(first:100){
                  nodes{
                    __typename
                    ... on CheckRun{name status conclusion detailsUrl}
                    ... on StatusContext{context state targetUrl description}
                  }
                  pageInfo{hasNextPage endCursor}
                }
              }
            }
          }
        }
      }
      pageInfo{hasNextPage endCursor}
    }
  }
}`;

const PR_FILES_QUERY = `
query($owner:String!,$name:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      files(first:100,after:$cursor){nodes{path}pageInfo{hasNextPage endCursor}}
    }
  }
}`;

const CHECK_CONTEXTS_QUERY = `
query($owner:String!,$name:String!,$oid:GitObjectID!,$cursor:String){
  repository(owner:$owner,name:$name){
    object(oid:$oid){
      ... on Commit{
        statusCheckRollup{
          contexts(first:100,after:$cursor){
            nodes{
              __typename
              ... on CheckRun{name status conclusion detailsUrl}
              ... on StatusContext{context state targetUrl description}
            }
            pageInfo{hasNextPage endCursor}
          }
        }
      }
    }
  }
}`;

const REVIEW_THREADS_QUERY = `
query($owner:String!,$name:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      reviewThreads(first:100,after:$cursor){
        nodes{
          id isResolved isOutdated path line originalLine
          comments(first:100){
            nodes{
              id author{login} authorAssociation body createdAt lastEditedAt updatedAt url
            }
            pageInfo{hasNextPage endCursor}
          }
        }
        pageInfo{hasNextPage endCursor}
      }
    }
  }
}`;

const THREAD_COMMENTS_QUERY = `
query($id:ID!,$cursor:String){
  node(id:$id){
    ... on PullRequestReviewThread{
      comments(first:100,after:$cursor){
        nodes{
          id author{login} authorAssociation body createdAt lastEditedAt updatedAt url
        }
        pageInfo{hasNextPage endCursor}
      }
    }
  }
}`;

const REVIEWS_QUERY = `
query($owner:String!,$name:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      reviews(first:100,after:$cursor){
        nodes{id author{login} authorAssociation body state submittedAt url}
        pageInfo{hasNextPage endCursor}
      }
    }
  }
}`;

const PR_COMMENTS_QUERY = `
query($owner:String!,$name:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      comments(first:100,after:$cursor){
        nodes{
          id author{login} authorAssociation body createdAt lastEditedAt updatedAt url
        }
        pageInfo{hasNextPage endCursor}
      }
    }
  }
}`;

function commandError(error) {
  return [error?.message, error?.stderr, error?.stdout]
    .filter(Boolean)
    .join(' — ')
    .replace(/\s+/g, ' ')
    .slice(0, 300) || 'command failed';
}

async function jsonCommandOnce(file, args, input, request) {
  return request.limitCommand(async () => {
    const stdout = await new Promise((resolve, reject) => {
      const child = execFile(file, args, {
        cwd: request.root,
        env: request.env,
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 64 * 1024 * 1024,
      }, (error, commandStdout, commandStderr) => {
        if (error) {
          error.stdout = commandStdout;
          error.stderr = commandStderr;
          reject(error);
        } else {
          resolve(commandStdout);
        }
      });
      child.stdin.end(input);
    });
    return JSON.parse(stdout);
  });
}

// Every gh call this scan makes is a read, so rerunning one cannot double an
// effect. A GitHub 5xx, a dropped connection or a 30 s stall used to fail the
// whole prime and end the run on a blip; now it costs a few seconds instead.
// Auth, not-found and malformed-query failures are not here: they fail again.
const TRANSIENT_COMMAND_RE =
  /HTTP 5\d\d|\b50[234]\b|timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|connection reset|unexpected EOF|TLS handshake|could not resolve host|secondary rate limit|rate limit exceeded/iu;
const COMMAND_RETRY_DELAYS_MS = Object.freeze([2000, 6000]);

export function transientCommandFailure(error) {
  if (error?.killed === true || error?.signal === 'SIGTERM') return true;
  return TRANSIENT_COMMAND_RE.test(`${error?.message ?? ''}\n${error?.stderr ?? ''}`);
}

export async function withCommandRetries(run, delaysMs = COMMAND_RETRY_DELAYS_MS, sleep = (ms) =>
  new Promise((resolve) => { setTimeout(resolve, ms); })) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= delaysMs.length || !transientCommandFailure(error)) throw error;
      await sleep(delaysMs[attempt]);
    }
  }
}

// Capture the environment once per request. Neither retries nor continuations
// can select a different checkout or inherit a later ambient override.
function createScanRequest(root) {
  root = resolve(root);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  delete env.GH_REPO;
  delete env.GH_HOST;
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0',
  });
  const request = {
    root, env, limitCommand: createLimiter(MAX_CONCURRENCY),
    repository: null, issueIds: new Map(), approvals: [], roles: new Map(),
  };
  request.gitText = (args) => execFileSync('git', [
    '--no-lazy-fetch', '--no-replace-objects', '--no-optional-locks',
    '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args,
  ], {
    cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20000, maxBuffer: 64 * 1024 * 1024,
  });
  request.bindRepository = () => {
    if (request.repository) return request.repository;
    const origins = request.gitText(['config', '--get-all', 'remote.origin.url']).trim().split(/\r?\n/u);
    const remote = origins.length === 1 ? parseGitHubRemote(origins[0]) : null;
    if (!remote) throw new Error('repository requires exactly one canonical origin URL');
    request.repository = { host: remote.host, owner: remote.owner, name: remote.repo };
    env.GH_HOST = remote.host;
    env.GH_REPO = `${remote.host}/${remote.owner}/${remote.repo}`;
    return request.repository;
  };
  request.ghJson = (args, input) => {
    const repository = request.bindRepository();
    const boundArgs = args[0] === 'api' ? [...args, '--hostname', repository.host] : args;
    return withCommandRetries(() => jsonCommandOnce('gh', boundArgs, input, request));
  };
  request.graphqlResponse = async (query, variables) => {
    const repository = request.bindRepository();
    if ((variables.owner !== undefined && variables.owner.toLowerCase() !== repository.owner)
      || (variables.name !== undefined && variables.name.toLowerCase() !== repository.name)) {
      throw new Error('GraphQL repository differs from the bound origin');
    }
    try {
      return await request.ghJson(['api', 'graphql', '--input', '-'], JSON.stringify({ query, variables }));
    } catch (error) {
      let body;
      try { body = JSON.parse(error?.stdout ?? ''); } catch { throw error; }
      if (Array.isArray(body?.errors)) return body;
      throw error;
    }
  };
  request.graphql = checkedGraphql(request.graphqlResponse);
  return request;
}

function checkedGraphql(graphqlResponse) {
  return async (query, variables) => {
    const response = await graphqlResponse(query, variables);
    if (Array.isArray(response.errors) && response.errors.length) {
      throw new Error(response.errors.map(({ message }) => message).join('; '));
    }
    if (!response.data) throw new Error('GraphQL response omitted data');
    return response.data;
  };
}

function repositoryRequest(repo) {
  return repo.request ?? createScanRequest(process.cwd());
}

function connectionPage(connection, label) {
  if (
    !connection
    || !Array.isArray(connection.nodes)
    || connection.nodes.some((node) =>
      node === null || typeof node !== 'object' || Array.isArray(node))
    || !connection.pageInfo
    || typeof connection.pageInfo.hasNextPage !== 'boolean'
  ) {
    throw new Error(`${label} returned an invalid connection`);
  }
  const nextCursor = connection.pageInfo.hasNextPage
    ? connection.pageInfo.endCursor
    : null;
  if (connection.pageInfo.hasNextPage && typeof nextCursor !== 'string') {
    throw new Error(`${label} omitted its next cursor`);
  }
  return { items: connection.nodes, nextCursor };
}

function sectionError(sections, fallback) {
  const messages = sections
    .filter((section) => section.complete !== true)
    .map((section) => `${section.error?.code}: ${section.error?.message}`);
  return messages.length ? messages.join('; ').slice(0, 300) : fallback;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pullRequestRepository(pr) {
  return typeof pr?.headRepository === 'string'
    ? pr.headRepository
    : pr?.headRepository?.nameWithOwner ?? null;
}

function loopOwnership(pr, repositoryNameWithOwner) {
  const claim = parseLoopClaim({ branch: pr?.headRefName, body: pr?.body });
  const sameRepository = typeof repositoryNameWithOwner === 'string'
    && repositoryNameWithOwner.length > 0
    && pullRequestRepository(pr) === repositoryNameWithOwner;
  return { claim, loopOwned: claim.valid && sameRepository };
}

export function classifyPrs(prs, repositoryNameWithOwner) {
  const loopOwned = [];
  const human = [];
  for (const entry of Array.isArray(prs) ? prs : []) {
    const pr = entry && typeof entry === 'object' && !Array.isArray(entry)
      ? entry
      : {};
    const { claim, loopOwned: owned } = loopOwnership(pr, repositoryNameWithOwner);
    if (owned) {
      loopOwned.push({ ...pr, issue: claim.issue, orphanCandidate: !!pr.isDraft });
    } else {
      human.push({ number: pr.number, headRefName: pr.headRefName });
    }
  }
  return { loopOwned, human };
}

export function normalizePullRequest(
  pr = {},
  statusContexts = undefined,
  repositoryNameWithOwner = null,
  changedFiles = undefined,
) {
  const value = pr && typeof pr === 'object' && !Array.isArray(pr) ? pr : {};
  const { claim, loopOwned } = loopOwnership(value, repositoryNameWithOwner);
  const commit = value.commits?.nodes?.at(-1)?.commit;
  const contexts = Array.isArray(statusContexts)
    ? statusContexts
    : commit?.statusCheckRollup?.contexts?.nodes ?? [];
  const files = Array.isArray(changedFiles) ? changedFiles : value.files?.nodes ?? [];
  return {
    number: Number.isSafeInteger(value.number) && value.number > 0 ? value.number : null,
    title: typeof value.title === 'string' ? value.title : '',
    body: typeof value.body === 'string' ? value.body : '',
    isDraft: value.isDraft === true,
    reviewDecision: value.reviewDecision ?? null,
    headRefName: typeof value.headRefName === 'string' ? value.headRefName : '',
    headRefOid: typeof value.headRefOid === 'string' ? value.headRefOid : null,
    baseRefName: typeof value.baseRefName === 'string' ? value.baseRefName : null,
    mergeStateStatus: value.mergeStateStatus ?? null,
    mergeable: value.mergeable ?? null,
    mergedAt: value.mergedAt ?? null,
    updatedAt: value.updatedAt ?? null,
    author: value.author?.login ?? null,
    headRepository: pullRequestRepository(value),
    statusCheckState: commit?.statusCheckRollup?.state ?? null,
    statusCheckRollup: contexts
      .map((context) => context.__typename === 'CheckRun'
        ? {
          kind: 'check-run',
          name: context.name ?? null,
          status: context.status ?? null,
          conclusion: context.conclusion ?? null,
          detailsUrl: context.detailsUrl ?? null,
        }
        : {
          kind: 'status-context',
          name: context.context ?? null,
          status: context.state ?? null,
          conclusion: null,
          detailsUrl: context.targetUrl ?? null,
        })
      .sort((left, right) => compareText(
        `${left.kind}\0${left.name ?? ''}`,
        `${right.kind}\0${right.name ?? ''}`,
      )),
    // The changed paths, for the overlap check against a plan boundary.
    files: [...new Set(files.map((file) => file?.path).filter((path) => typeof path === 'string' && path.length > 0))]
      .sort(compareText),
    issue: loopOwned ? claim.issue : null,
    orphanCandidate: loopOwned && pr.isDraft === true,
    ownership: loopOwned ? 'loop' : 'human',
  };
}

export function labelProvenance(timeline) {
  const events = (Array.isArray(timeline) ? timeline : []).filter(
    (event) => (
      event?.event === 'labeled'
      || event?.__typename === 'LabeledEvent'
    ) && event.label?.name?.toLowerCase() === 'loop-ready',
  );
  const last = events.at(-1);
  return last
    ? {
      labeledBy: last.actor?.login ?? null,
      labeledAt: last.createdAt ?? last.created_at ?? null,
    }
    : null;
}

async function fetchRepo(request) {
  try {
    const bound = request.bindRepository();
    const data = await request.ghJson(['repo', 'view', `${bound.host}/${bound.owner}/${bound.name}`, '--json', 'nameWithOwner,defaultBranchRef,id']);
    const [owner, name] = String(data.nameWithOwner ?? '').split('/');
    if (!owner || !name || String(data.nameWithOwner).toLowerCase() !== `${bound.owner}/${bound.name}`) {
      throw new Error('repository identity differs from the bound origin');
    }
    if (typeof data.defaultBranchRef?.name !== 'string') {
      throw new Error('repository default branch is unavailable');
    }
    request.repositorySource = { host: bound.host, owner, name, nodeId: sourceId(data.id) };
    return completeSection([{
      owner,
      name,
      nameWithOwner: data.nameWithOwner,
      defaultBranch: data.defaultBranchRef.name,
    }]);
  } catch (error) {
    return incompleteSection('REPOSITORY_FETCH_FAILED', commandError(error));
  }
}

function fetchTree(request) {
  try {
    const dirtyEntries = readGitStatus(request.root, { zeroTerminated: true }).toString('utf8').split('\0').filter(Boolean);
    return completeSection([{
      dirtyEntries,
      dirtyPaths: dirtyEntries.length,
      branch: request.gitText(['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
      headOid: request.gitText(['rev-parse', '--verify', 'HEAD^{commit}']).trim().toLowerCase(),
    }]);
  } catch (error) {
    return incompleteSection('TREE_FETCH_FAILED', commandError(error));
  }
}

export async function fetchPullRequests(repo, states, { graphql = repositoryRequest(repo).graphql } = {}) {
  const section = await collectPaginated(async (cursor) => {
    const data = await graphql(PULL_REQUESTS_QUERY, {
      owner: repo.owner,
      name: repo.name,
      states,
      cursor,
    });
    return connectionPage(data.repository?.pullRequests, 'pull requests');
  }, { maxPages: MAX_PAGES, maxItems: MAX_ITEMS });
  if (!states.includes('OPEN')) {
    const items = section.items
      .map((pr) => normalizePullRequest(pr, [], repo.nameWithOwner, []))
      .sort((left, right) => left.number - right.number);
    return section.complete
      ? completeSection(items)
      : incompleteSection(section.error.code, section.error.message, items);
  }
  const checks = await mapBounded(section.items, MAX_CONCURRENCY, async (pr) => ({
    pr,
    section: await fetchCheckContexts(repo, pr, graphql),
    files: await fetchChangedFiles(repo, pr, graphql),
  }));
  const items = checks
    .map(({ pr, section: checkSection, files }) =>
      normalizePullRequest(pr, checkSection.items, repo.nameWithOwner, files.items))
    .sort((left, right) => left.number - right.number);
  const dependencies = [section, ...checks.flatMap(({ section: value, files }) => [value, files])];
  return dependencies.every((value) => value.complete)
    ? completeSection(items)
    : incompleteSection(
      'OPEN_PR_CHECKS_INCOMPLETE',
      sectionError(dependencies, 'open PR check evidence is incomplete'),
      items,
    );
}

// The first page of changed paths rides on the PR node; a PR with more than
// 100 changed files is paged to completion, so an overlap is never missed.
async function fetchChangedFiles(repo, pr, graphql) {
  let initial = true;
  return collectPaginated(async (cursor) => {
    if (initial) {
      initial = false;
      return connectionPage(pr.files, `PR #${pr.number} changed files`);
    }
    const data = await graphql(PR_FILES_QUERY, {
      owner: repo.owner,
      name: repo.name,
      number: pr.number,
      cursor,
    });
    return connectionPage(data.repository?.pullRequest?.files, `PR #${pr.number} changed files`);
  }, { maxPages: MAX_PAGES, maxItems: MAX_ITEMS });
}

async function fetchCheckContexts(repo, pr, graphql = repositoryRequest(repo).graphql) {
  const commit = pr.commits?.nodes?.at(-1)?.commit;
  if (!commit?.statusCheckRollup) return completeSection([]);
  let initial = true;
  return collectPaginated(async (cursor) => {
    if (initial) {
      initial = false;
      return connectionPage(
        commit.statusCheckRollup.contexts,
        `PR #${pr.number} status checks`,
      );
    }
    const data = await graphql(CHECK_CONTEXTS_QUERY, {
      owner: repo.owner,
      name: repo.name,
      oid: commit.oid,
      cursor,
    });
    return connectionPage(
      data.repository?.object?.statusCheckRollup?.contexts,
      `PR #${pr.number} status checks`,
    );
  }, { maxPages: MAX_PAGES, maxItems: MAX_ITEMS });
}

async function fetchIssueLabels(repo, issue) {
  let initial = true;
  return collectPaginated(async (cursor) => {
    if (initial) {
      initial = false;
      return connectionPage(issue.labels, `issue #${issue.number} labels`);
    }
    const data = await repositoryRequest(repo).graphql(ISSUE_LABELS_QUERY, {
      id: issue.id,
      cursor,
    });
    return connectionPage(data.node?.labels, `issue #${issue.number} labels`);
  }, { maxPages: MAX_PAGES, maxItems: MAX_ITEMS });
}

export function normalizeDependencyIssueSection(issueNumber, issue) {
  if (
    !Number.isSafeInteger(issueNumber)
    || issueNumber < 1
    || issue?.__typename !== 'Issue'
    || issue.number !== issueNumber
    || !['CLOSED', 'OPEN'].includes(issue.state)
  ) {
    return incompleteSection(
      'DEPENDENCY_ISSUE_INVALID',
      `dependency #${issueNumber} is missing, unavailable, or is not an issue`,
    );
  }
  return completeSection([{
    number: issue.number,
    state: issue.state,
  }]);
}

async function fetchDependencyIssue(repo, issueNumber) {
  try {
    const data = await repositoryRequest(repo).graphql(DEPENDENCY_ISSUE_QUERY, {
      owner: repo.owner,
      name: repo.name,
      number: issueNumber,
    });
    return normalizeDependencyIssueSection(
      issueNumber,
      data.repository?.issue,
    );
  } catch (error) {
    return incompleteSection(
      'DEPENDENCY_ISSUE_FETCH_FAILED',
      `dependency #${issueNumber}: ${commandError(error)}`,
    );
  }
}

export function issueBatchQuery(requests) {
  const aliases = requests.map(({ number, parts }) => {
    if (!Number.isSafeInteger(number) || number < 1) {
      throw new TypeError(`issue batch number must be a positive integer, got ${String(number).slice(0, 40)}`);
    }
    if (!parts.length || parts.some((part) => !Object.hasOwn(ISSUE_BATCH_FIELDS, part))) {
      throw new TypeError(`issue batch parts are invalid for #${number}`);
    }
    return `i${number}:issue(number:${number}){${parts.map((part) => ISSUE_BATCH_FIELDS[part]).join(' ')}}`;
  });
  return `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${aliases.join(' ')}}}`;
}

export function issueBatchChunks(requests, size = ISSUE_BATCH_SIZE) {
  const chunks = [];
  for (let start = 0; start < requests.length; start += size) {
    chunks.push(requests.slice(start, start + size));
  }
  return chunks;
}

// An error whose path names an alias fails that issue alone. Any other error,
// or a response without data, fails the whole batch: its issues are left out,
// so each falls back to its single-issue read. Absence is never inferred.
function splitIssueBatch(response, chunk) {
  const errors = Array.isArray(response?.errors) ? response.errors : [];
  const aliasOf = (error) => (Array.isArray(error?.path) && error.path[0] === 'repository'
    && typeof error.path[1] === 'string' ? error.path[1] : null);
  const messagesFor = (alias) => {
    const matching = errors.filter((error) => aliasOf(error) === alias);
    return matching.length ? matching.map(({ message }) => message).join('; ') : null;
  };
  const repository = response?.data?.repository;
  if (messagesFor(null) !== null || !repository) return [];
  return chunk.map(({ number }) => ({
    number,
    node: repository[`i${number}`] ?? null,
    error: messagesFor(`i${number}`),
  }));
}

export async function fetchIssueBatches(repo, requests, { graphql = repositoryRequest(repo).graphqlResponse } = {}) {
  const continuation = checkedGraphql(graphql);
  const chunks = await mapBounded(issueBatchChunks(requests), MAX_CONCURRENCY, async (chunk) => {
    let response;
    try {
      response = await graphql(issueBatchQuery(chunk), { owner: repo.owner, name: repo.name });
    } catch (error) {
      response = { errors: [{ message: commandError(error) }] };
    }
    return splitIssueBatch(response, chunk);
  });
  const partsOf = new Map(requests.map(({ number, parts }) => [number, parts]));
  const entries = await Promise.all(chunks.flat().map(async ({ number, node, error }) => {
    const parts = partsOf.get(number);
    const firstPage = (connection, label) => () => {
      if (error !== null) throw new Error(error);
      return connectionPage(connection, label);
    };
    const result = {};
    if (parts.includes('comments')) {
      result.comments = await fetchIssueComments(repo, number,
        firstPage(node?.comments, `issue #${number} comments`), continuation);
    }
    if (parts.includes('timeline')) {
      result.timeline = await fetchIssueTimeline(repo, { number },
        firstPage(node?.timelineItems, `issue #${number} timeline`), continuation);
    }
    if (parts.includes('dependency')) {
      result.dependency = error === null
        ? normalizeDependencyIssueSection(number, node)
        : incompleteSection('DEPENDENCY_ISSUE_FETCH_FAILED', `dependency #${number}: ${error}`);
    }
    return [number, result];
  }));
  return new Map(entries);
}

async function fetchIssueComments(repo, issueNumber, firstPage = null, graphql = repositoryRequest(repo).graphql) {
  return collectPaginated(async (cursor, page) => {
    if (page === 1 && firstPage !== null) return firstPage();
    const data = await graphql(ISSUE_COMMENTS_QUERY, {
      owner: repo.owner,
      name: repo.name,
      number: issueNumber,
      cursor,
    });
    return connectionPage(
      data.repository?.issue?.comments,
      `issue #${issueNumber} comments`,
    );
  }, { maxPages: MAX_PAGES, maxItems: MAX_ITEMS });
}

function lifecycleMarkerCandidate(comment) {
  return typeof comment?.body === 'string'
    && comment.body.includes('<!-- autoloop-lifecycle-v');
}

function lifecycleChainInput(comment) {
  return {
    id: comment.id,
    body: comment.body,
    neverEdited: lifecycleCommentNeverEdited(comment),
  };
}

export function normalizeLifecycleMarkerComment(
  comment,
  issueNumber,
  chain = {},
) {
  return lifecycleMarkerSnapshotItem(comment, issueNumber, chain);
}

export function normalizeLifecycleMarkerSection(
  issueNumber,
  section,
  trustedAuthors = new Set(),
) {
  const candidates = Array.isArray(section?.items)
    ? section.items.filter((comment) =>
      lifecycleMarkerCandidate(comment)
      && trustedAuthors.has(comment.author?.login))
    : [];
  const parsed = candidates.map((comment) => ({
    comment,
    result: parseLifecycleComment(comment.body),
  }));
  const valid = parsed.filter(({ result }) =>
    result.ok === true && result.marker.issue === issueNumber);
  const malformed = parsed.length - valid.length;
  if (malformed > 0) {
    return incompleteSection(
      'LIFECYCLE_MARKER_INVALID',
      `issue #${issueNumber} has ${malformed} malformed or mismatched lifecycle marker comment(s)`,
    );
  }
  let chain = null;
  try {
    chain = resolveLifecycleCommentChain(
      valid.map(({ comment }) => lifecycleChainInput(comment)),
    );
    if (chain !== null) {
      const rootAuthor = valid.find(
        ({ comment }) => comment.id === chain.root.id,
      )?.comment.author?.login;
      if (
        typeof rootAuthor !== 'string'
        || valid.some(({ comment, result }) =>
          (
            result.successor === null
            || result.successor.rootCommentId === chain.root.id
          )
          && comment.author?.login !== rootAuthor)
      ) {
        throw new Error('lifecycle chain author changed');
      }
      chain = resolveLifecycleCommentChain(
        valid
          .filter(({ comment }) => comment.author?.login === rootAuthor)
          .map(({ comment }) => lifecycleChainInput(comment)),
      );
    }
  } catch (error) {
    const ambiguous = /ambiguous|fork/u.test(String(error?.message ?? error));
    return incompleteSection(
      ambiguous ? 'LIFECYCLE_MARKER_AMBIGUOUS' : 'LIFECYCLE_MARKER_INVALID',
      `issue #${issueNumber} lifecycle chain is invalid: ${String(error?.message ?? error)}`,
    );
  }
  const root = chain === null
    ? null
    : valid.find(({ comment }) => comment.id === chain.root.id)?.comment;
  const tip = chain === null
    ? null
    : valid.find(({ comment }) => comment.id === chain.tip.id)?.comment;
  const items = root && tip
    ? [normalizeLifecycleMarkerComment(tip, issueNumber, {
        root,
        sequence: chain.sequence,
      })]
    : [];
  if (section?.complete !== true) {
    return incompleteSection(
      section?.error?.code ?? 'ISSUE_COMMENTS_INCOMPLETE',
      section?.error?.message ?? `issue #${issueNumber} comments are incomplete`,
      items,
    );
  }
  return completeSection(items);
}

function lifecycleIssueNumbers(openPrs, openIssues, mergedPrs) {
  return [...new Set([
    ...openIssues.items.map((issue) => issue.number),
    ...openPrs.items.map((pr) => pr.issue).filter(Number.isSafeInteger),
    ...mergedPrs.items.map((pr) => pr.issue).filter(Number.isSafeInteger),
  ])].sort((left, right) => left - right);
}

function lifecycleTrustedAuthors(roleSections, viewerAuthoredLogins) {
  return new Set(
    roleSections
      .flatMap((section) => section.items)
      .filter((role) =>
        TRUSTED_LIFECYCLE_ROLES.has(role.roleName)
        || (role.roleName === 'write' && viewerAuthoredLogins.has(role.login)))
      .map((role) => role.login),
  );
}

const TERMINAL_LIFECYCLE_PHASES = new Set(['terminal-record', 'terminal-refused']);

// A terminal tip on an issue the complete open-issue inventory does not list is
// a finished unit: reconciling it again can only return what it already says.
export function surfacedLifecycleMarkers(items, openIssues) {
  if (openIssues.complete !== true) return items;
  const open = new Set(openIssues.items.map((issue) => issue.number));
  return items.filter((item) => open.has(item.issueNumber)
    || !TERMINAL_LIFECYCLE_PHASES.has(parseLifecycleComment(item.body).marker?.phase));
}

async function fetchLifecycleMarkers(openPrs, openIssues, mergedPrs, repo, issueData = new Map()) {
  const issueNumbers = lifecycleIssueNumbers(openPrs, openIssues, mergedPrs);
  const commentsByIssue = await mapBounded(
    issueNumbers,
    MAX_CONCURRENCY,
    async (issueNumber) => ({
      issueNumber,
      section: issueData.get(issueNumber)?.comments ?? await fetchIssueComments(repo, issueNumber),
    }),
  );
  const authors = [...new Set(
    commentsByIssue
      .flatMap(({ section }) => section.items)
      .filter(lifecycleMarkerCandidate)
      .map((comment) => comment.author?.login)
      .filter((login) => typeof login === 'string' && login.length > 0),
  )].sort();
  const roleSections = await mapBounded(
    authors,
    MAX_CONCURRENCY,
    (login) => fetchRole(repo, login),
  );
  const viewerAuthoredLogins = new Set(
    commentsByIssue
      .flatMap(({ section }) => section.items)
      .filter((comment) => lifecycleMarkerCandidate(comment) && comment.viewerDidAuthor === true)
      .map((comment) => comment.author?.login)
      .filter((login) => typeof login === 'string' && login.length > 0),
  );
  const trustedAuthors = lifecycleTrustedAuthors(roleSections, viewerAuthoredLogins);
  const perIssue = commentsByIssue.map(({ issueNumber, section }) =>
    normalizeLifecycleMarkerSection(issueNumber, section, trustedAuthors));
  const dependencies = [
    openPrs,
    openIssues,
    mergedPrs,
    ...roleSections,
    ...perIssue,
  ];
  const items = surfacedLifecycleMarkers(perIssue.flatMap((section) => section.items), openIssues)
    .sort((left, right) => compareText(
      `${left.issueNumber}\0${left.createdAt ?? ''}\0${left.id ?? ''}`,
      `${right.issueNumber}\0${right.createdAt ?? ''}\0${right.id ?? ''}`,
    ));
  return dependencies.every((section) => section.complete)
    ? completeSection(items)
    : incompleteSection(
      'LIFECYCLE_MARKERS_INCOMPLETE',
      sectionError(dependencies, 'lifecycle marker evidence is incomplete'),
      items,
    );
}

async function fetchOpenIssues(repo) {
  const base = await collectPaginated(async (cursor) => {
    const data = await repositoryRequest(repo).graphql(ISSUES_QUERY, {
      owner: repo.owner,
      name: repo.name,
      cursor,
    });
    return connectionPage(data.repository?.issues, 'open issues');
  }, { maxPages: MAX_PAGES, maxItems: MAX_ITEMS });
  const enriched = await mapBounded(base.items, MAX_CONCURRENCY, async (issue) => {
    repo.request.issueIds.set(issue.number, sourceId(issue.id));
    const labels = await fetchIssueLabels(repo, issue);
    return {
      section: labels,
      item: issueSnapshotItem({
        ...issue,
        labels: labels.items,
      }),
    };
  });
  const labelSections = enriched.map(({ section }) => section);
  const items = enriched.map(({ item }) => item)
    .sort((left, right) => left.number - right.number);
  if (base.complete && labelSections.every((section) => section.complete)) {
    return completeSection(items);
  }
  return incompleteSection(
    'OPEN_ISSUES_INCOMPLETE',
    sectionError([base, ...labelSections], 'open issue evidence is incomplete'),
    items,
  );
}

function issueHasLabel(issue, label) {
  return issue.labels.some((name) => name.toLowerCase() === label);
}

/** Pure: the newest loop-ready label or unlabel event, or null. */
export function lastLoopReadyEvent(timeline) {
  const events = (Array.isArray(timeline) ? timeline : []).filter(
    (event) => ['LabeledEvent', 'UnlabeledEvent'].includes(event?.__typename)
      && event.label?.name?.toLowerCase() === 'loop-ready',
  );
  const last = events.at(-1);
  return last
    ? {
      event: last.__typename === 'LabeledEvent' ? 'labeled' : 'unlabeled',
      actor: last.actor?.login ?? null,
      at: last.createdAt ?? null,
    }
    : null;
}

/** Pure: a loop repair's queue facts. Its provenance is the parent's loop-ready
 *  event its marker copied; the snapshot contract checks that event is still the
 *  parent's newest, and that the loop wrote the repair. */
export function repairItemFacts(marker, parentTimeline, facts) {
  const parentLabels = (facts?.parent?.labels?.nodes ?? []).map((label) => label?.name);
  return {
    provenance: { labeledBy: marker.parentLabeledBy, labeledAt: marker.parentLabeledAt },
    repair: {
      parent: marker.parent,
      parentLabeledBy: marker.parentLabeledBy,
      parentLabeledAt: marker.parentLabeledAt,
      viewerDidAuthor: facts?.repair?.viewerDidAuthor === true,
      parentLastReadyEvent: lastLoopReadyEvent(parentTimeline),
      parentState: facts?.parent?.state === 'OPEN' ? 'OPEN' : 'CLOSED',
      parentStateReason: facts?.parent?.stateReason ?? null,
      parentBlocked: parentLabels.includes('loop-blocked'),
      parentDelivered: parentLabels.includes('loop-delivered'),
      blocksParent: marker.blocksParent === true,
      // Passed through as read: a missing field fails the facts schema
      // instead of reading as never edited.
      parentLastEditedAt: facts?.parent?.lastEditedAt,
    },
  };
}

async function fetchIssueTimeline(repo, issue, firstPage = null, graphql = repositoryRequest(repo).graphql) {
  return collectPaginated(async (cursor, page) => {
    if (page === 1 && firstPage !== null) return firstPage();
    const data = await graphql(ISSUE_TIMELINE_QUERY, {
      owner: repo.owner,
      name: repo.name,
      number: issue.number,
      cursor,
    });
    return connectionPage(
      data.repository?.issue?.timelineItems,
      `issue #${issue.number} timeline`,
    );
  }, { maxPages: MAX_PAGES, maxItems: MAX_ITEMS });
}

// A loop repair without a parseable marker is not queue work, and must not
// make the queue incomplete either: it is simply never eligible.
function queueCandidates(openIssues) {
  return openIssues.items.filter((issue) => issueHasLabel(issue, 'loop-ready')
    || (issueHasLabel(issue, 'loop-repair') && parseRepair(issue.body) !== null));
}

function queueReferenceNumbers(candidates) {
  return [...new Set(candidates.flatMap((issue) => blockedByIssueNumbers(issue.body)))];
}

// Every per-issue read the snapshot needs, merged per issue so one alias carries
// an open issue's comments and its label timeline together.
export function issueBatchRequests(openPrs, openIssues, mergedPrs) {
  const parts = new Map();
  const add = (number, part) => {
    if (!parts.has(number)) parts.set(number, new Set());
    parts.get(number).add(part);
  };
  for (const number of lifecycleIssueNumbers(openPrs, openIssues, mergedPrs)) add(number, 'comments');
  const candidates = queueCandidates(openIssues);
  for (const issue of candidates) {
    if (issueHasLabel(issue, 'loop-ready')) add(issue.number, 'timeline');
  }
  const references = queueReferenceNumbers(candidates);
  if (references.length <= MAX_ITEMS) {
    for (const number of references.filter((value) => Number.isSafeInteger(value) && value > 0)) {
      add(number, 'dependency');
    }
  }
  return [...parts]
    .sort(([left], [right]) => left - right)
    .map(([number, set]) => ({ number, parts: [...set].sort() }));
}

async function fetchQueue(openIssues, repo, issueData = new Map()) {
  const candidates = queueCandidates(openIssues);
  const referenceNumbers = queueReferenceNumbers(candidates);
  const referenceLimit = referenceNumbers.length <= MAX_ITEMS
    ? completeSection([])
    : incompleteSection(
      'DEPENDENCY_REFERENCE_LIMIT',
      `queue references exceed the ${MAX_ITEMS}-issue evidence bound`,
    );
  const dependencySections = referenceLimit.complete
    ? await mapBounded(
      referenceNumbers,
      MAX_CONCURRENCY,
      (issueNumber) => issueData.get(issueNumber)?.dependency ?? fetchDependencyIssue(repo, issueNumber),
    )
    : [];
  const dependenciesByNumber = new Map(
    referenceNumbers.map((number, index) => [
      number,
      dependencySections[index]
        ?? incompleteSection(
          'DEPENDENCY_REFERENCE_LIMIT',
          `dependency #${number} was not fetched because the queue reference bound was exceeded`,
        ),
    ]),
  );
  const timelines = await mapBounded(candidates, MAX_CONCURRENCY, async (issue) => {
    const blockedBy = blockedByIssueNumbers(issue.body);
    const dependencies = blockedBy
      .map((number) => dependenciesByNumber.get(number)?.items[0])
      .filter(Boolean);
    const issueDependencySections = blockedBy
      .map((number) => dependenciesByNumber.get(number));
    const marker = issueHasLabel(issue, 'loop-ready') ? null : parseRepair(issue.body);
    let section;
    let provenance;
    let repairFacts = {};
    let approvalIssueNodeId = repo.request.issueIds.get(issue.number) ?? null;
    let issueNodeId = approvalIssueNodeId;
    if (marker === null) {
      section = issueData.get(issue.number)?.timeline ?? await fetchIssueTimeline(repo, issue);
      provenance = labelProvenance(section.items);
    } else {
      // A repair whose parent GitHub definitively does not have is not queue
      // work. A request that failed proves nothing, so the queue is incomplete,
      // exactly as for an ordinary issue's timeline: absence is never concluded
      // from missing data.
      const parentTimeline = await fetchIssueTimeline(repo, { number: marker.parent });
      let data = null;
      let failure = null;
      try {
        data = await repositoryRequest(repo).graphql(REPAIR_FACTS_QUERY, { owner: repo.owner, name: repo.name, number: issue.number, parent: marker.parent });
      } catch (error) {
        failure = commandError(error);
      }
      if (failure !== null || !parentTimeline.complete) {
        return {
          item: null,
          section: incompleteSection(
            'REPAIR_FACTS_UNAVAILABLE',
            `repair #${issue.number}: ${failure ?? parentTimeline.error?.message ?? 'parent timeline incomplete'}`,
          ),
          labelEvidence: null,
        };
      }
      if (!data?.repository?.parent || !data.repository.repair) {
        return { item: null, section: completeSection([]), labelEvidence: null };
      }
      section = parentTimeline;
      approvalIssueNodeId = sourceId(data.repository.parent.id);
      if (sourceId(data.repository.repair.id) !== issueNodeId) issueNodeId = null;
      const facts = repairItemFacts(marker, parentTimeline.items, data.repository);
      provenance = facts.provenance;
      repairFacts = { repair: facts.repair };
    }
    const provenanceComplete =
      typeof provenance?.labeledBy === 'string'
      && provenance.labeledBy.length > 0
      && typeof provenance.labeledAt === 'string'
      && provenance.labeledAt.length > 0;
    const event = section.items.filter((entry) => ['LabeledEvent', 'UnlabeledEvent'].includes(entry?.__typename)
      && entry.label?.name?.toLowerCase() === 'loop-ready').at(-1);
    const matching = section.complete && event?.__typename === 'LabeledEvent'
      && event.actor?.login === provenance?.labeledBy && event.createdAt === provenance?.labeledAt;
    repo.request.approvals.push({
      issue: issue.number, issueNodeId,
      approvalIssue: marker?.parent ?? issue.number, approvalIssueNodeId,
      eventId: matching ? sourceId(event.id) : null,
      actorLogin: matching ? event.actor.login : null,
      createdAt: matching ? sourceTimestamp(event.createdAt) : null,
      kind: marker === null ? 'loop-ready' : 'repair-parent',
    });
    const item = {
      ...issue,
      blockedBy,
      dependencies,
      provenance,
      ...repairFacts,
    };
    const complete = section.complete
      && provenanceComplete
      && referenceLimit.complete
      && issueDependencySections.every((dependency) => dependency?.complete === true);
    return {
      item,
      section: complete
        ? completeSection([])
        : incompleteSection(
          !section.complete
            ? section.error.code
            : !provenanceComplete
              ? 'LABEL_PROVENANCE_MISSING'
              : 'DEPENDENCY_EVIDENCE_INCOMPLETE',
          !section.complete
            ? section.error.message
            : !provenanceComplete
              ? `issue #${issue.number} has no visible loop-ready label event`
              : sectionError(
                [referenceLimit, ...issueDependencySections],
                `issue #${issue.number} dependency evidence is incomplete`,
              ),
        ),
      labelEvidence: provenanceComplete
        ? {
          kind: 'queue-label',
          issueNumber: issue.number,
          author: provenance.labeledBy,
          authorAssociation: null,
          body: '',
          createdAt: provenance.labeledAt,
          updatedAt: null,
          url: null,
        }
        : null,
    };
  });
  const items = timelines.map(({ item }) => item)
    .filter(Boolean)
    .sort((left, right) => left.number - right.number);
  const dependent = [
    openIssues,
    referenceLimit,
    ...dependencySections,
    ...timelines.map(({ section }) => section),
  ];
  return {
    section: dependent.every((section) => section.complete)
      ? completeSection(items)
      : incompleteSection(
        'QUEUE_INCOMPLETE',
        sectionError(dependent, 'queue evidence is incomplete'),
        items,
      ),
    labelEvidence: timelines.map(({ labelEvidence }) => labelEvidence).filter(Boolean),
  };
}

function derivedIssueSection(openIssues, label) {
  const items = openIssues.items.filter((issue) => issueHasLabel(issue, label));
  return openIssues.complete
    ? completeSection(items)
    : incompleteSection(
      'OPEN_ISSUES_INCOMPLETE',
      `cannot prove ${label} issue absence from an incomplete open-issue section`,
      items,
    );
}

async function fetchThreadConnection(repo, pr) {
  const section = await collectPaginated(async (cursor) => {
    const data = await repositoryRequest(repo).graphql(REVIEW_THREADS_QUERY, {
      owner: repo.owner,
      name: repo.name,
      number: pr.number,
      cursor,
    });
    return connectionPage(
      data.repository?.pullRequest?.reviewThreads,
      `PR #${pr.number} review threads`,
    );
  }, { maxPages: MAX_PAGES, maxItems: MAX_ITEMS });
  return section.items.every(validThreadConnectionItem)
    ? section
    : incompleteSection(
      'REVIEW_THREAD_SHAPE_INVALID',
      `PR #${pr.number} returned malformed review thread facts`,
      section.items,
    );
}

async function fetchThreadComments(repo, thread) {
  let initial = true;
  return collectPaginated(async (cursor) => {
    if (initial) {
      initial = false;
      return connectionPage(thread.comments, `thread ${thread.id} comments`);
    }
    const data = await repositoryRequest(repo).graphql(THREAD_COMMENTS_QUERY, {
      id: thread.id,
      cursor,
    });
    return connectionPage(data.node?.comments, `thread ${thread.id} comments`);
  }, { maxPages: MAX_PAGES, maxItems: MAX_ITEMS });
}

function normalizeComment(comment, prNumber, kind) {
  return {
    kind,
    id: comment.id ?? null,
    prNumber,
    author: comment.author?.login ?? null,
    authorAssociation: comment.authorAssociation ?? null,
    body: typeof comment.body === 'string' ? comment.body : '',
    state: comment.state ?? null,
    createdAt: comment.createdAt ?? comment.submittedAt ?? null,
    updatedAt: comment.updatedAt ?? comment.lastEditedAt ?? null,
    url: comment.url ?? null,
  };
}

function validThreadConnectionItem(thread) {
  if (
    !thread
    || typeof thread !== 'object'
    || Array.isArray(thread)
    || typeof thread.id !== 'string'
    || thread.id.length === 0
    || typeof thread.isResolved !== 'boolean'
    || typeof thread.isOutdated !== 'boolean'
    || typeof thread.path !== 'string'
    || thread.path.length === 0
    || !(thread.line === null || (Number.isSafeInteger(thread.line) && thread.line > 0))
    || !(
      thread.originalLine === null
      || (Number.isSafeInteger(thread.originalLine) && thread.originalLine > 0)
    )
  ) {
    return false;
  }
  try {
    connectionPage(thread.comments, `thread ${thread.id} comments`);
    return true;
  } catch {
    return false;
  }
}

function normalizeReviewThread(thread, prNumber, comments) {
  return {
    id: thread.id,
    prNumber,
    path: thread.path ?? null,
    line: thread.line ?? null,
    originalLine: thread.originalLine ?? null,
    isOutdated: typeof thread.isOutdated === 'boolean' ? thread.isOutdated : null,
    comments: comments
      .map((comment) =>
        normalizeComment(comment, prNumber, 'review-thread-comment'))
      .sort((left, right) => compareText(
        `${left.createdAt ?? ''}\0${left.id ?? ''}`,
        `${right.createdAt ?? ''}\0${right.id ?? ''}`,
      )),
  };
}

async function fetchUnresolvedThreads(openPrs, repo) {
  const loopPrs = openPrs.items.filter((pr) => pr.ownership === 'loop');
  const perPr = await mapBounded(loopPrs, MAX_CONCURRENCY, async (pr) => ({
    pr,
    section: await fetchThreadConnection(repo, pr),
  }));
  const unresolved = perPr.flatMap(({ pr, section }) =>
    section.items
      .filter((thread) =>
        validThreadConnectionItem(thread) && thread.isResolved === false)
      .map((thread) => ({ pr, thread })));
  const completed = await mapBounded(unresolved, MAX_CONCURRENCY, async ({ pr, thread }) => {
    const comments = await fetchThreadComments(repo, thread);
    return {
      section: comments,
      item: normalizeReviewThread(thread, pr.number, comments.items),
    };
  });
  const dependencies = [
    openPrs,
    ...perPr.map(({ section }) => section),
    ...completed.map(({ section }) => section),
  ];
  const items = completed.map(({ item }) => item)
    .sort((left, right) => compareText(
      `${left.prNumber}\0${left.id ?? ''}`,
      `${right.prNumber}\0${right.id ?? ''}`,
    ));
  return dependencies.every((section) => section.complete)
    ? completeSection(items)
    : incompleteSection(
      'REVIEW_THREADS_INCOMPLETE',
      sectionError(dependencies, 'review thread evidence is incomplete'),
      items,
    );
}

async function fetchPrConnection(repo, pr, query, field, label) {
  return collectPaginated(async (cursor) => {
    const data = await repositoryRequest(repo).graphql(query, {
      owner: repo.owner,
      name: repo.name,
      number: pr.number,
      cursor,
    });
    return connectionPage(
      data.repository?.pullRequest?.[field],
      `PR #${pr.number} ${label}`,
    );
  }, { maxPages: MAX_PAGES, maxItems: MAX_ITEMS });
}

async function fetchReviewEvidence(openPrs, repo) {
  const loopPrs = openPrs.items.filter((pr) => pr.ownership === 'loop');
  const perPr = await mapBounded(loopPrs, MAX_CONCURRENCY, async (pr) => {
    const [reviews, comments] = await Promise.all([
      fetchPrConnection(repo, pr, REVIEWS_QUERY, 'reviews', 'reviews'),
      fetchPrConnection(repo, pr, PR_COMMENTS_QUERY, 'comments', 'comments'),
    ]);
    return {
      sections: [reviews, comments],
      items: [
        ...reviews.items.map((review) => normalizeComment(review, pr.number, 'review')),
        ...comments.items.map((comment) => normalizeComment(comment, pr.number, 'issue-comment')),
      ],
    };
  });
  const sections = [openPrs, ...perPr.flatMap(({ sections: values }) => values)];
  const items = perPr.flatMap(({ items: values }) => values);
  return sections.every((section) => section.complete)
    ? completeSection(items)
    : incompleteSection(
      'AUTHOR_COMMENTS_INCOMPLETE',
      sectionError(sections, 'author comment evidence is incomplete'),
      items,
    );
}

function roleFailureSection(error) {
  return incompleteSection('AUTHOR_ROLE_FETCH_FAILED', commandError(error));
}

function normalizeRoleResponse(data, login) {
  if (
    !data
    || typeof login !== 'string'
    || login.length === 0
    || !ROLE_PERMISSIONS.has(data.permission)
    || typeof data.role_name !== 'string'
    || data.user?.login !== login
    || !Number.isSafeInteger(data.user?.id)
    || data.user.id <= 0
  ) {
    return null;
  }
  return {
    login,
    roleName: data.role_name ?? null,
    permission: data.permission,
  };
}

async function fetchRole(repo, login) {
  try {
    const data = await repo.request.ghJson([
      'api',
      '--method',
      'GET',
      `repos/${repo.owner}/${repo.name}/collaborators/${encodeURIComponent(login)}/permission`,
    ]);
    const role = normalizeRoleResponse(data, login);
    repo.request.roles.set(login, {
      login,
      userId: data?.user?.login === login && Number.isSafeInteger(data.user.id) && data.user.id > 0
        ? data.user.id : null,
      permission: ROLE_PERMISSIONS.has(data?.permission) ? data.permission : null,
      roleName: typeof data?.role_name === 'string' ? data.role_name : null,
    });
    if (!role) {
      return roleFailureSection(new Error(`author permission response for ${login} is incomplete`));
    }
    return completeSection([role]);
  } catch (error) {
    repo.request.roles.set(login, { login, userId: null, permission: null, roleName: null });
    return roleFailureSection(error);
  }
}

async function fetchAuthorVerification(
  openPrs,
  reviewEvidence,
  unresolvedThreads,
  queue,
  repo,
) {
  const threadEvidence = unresolvedThreads.items.flatMap(({ comments }) => comments);
  const rawEvidence = [
    ...reviewEvidence.items,
    ...threadEvidence,
    ...queue.labelEvidence,
  ];
  const identityComplete = rawEvidence.every(({ author }) =>
    typeof author === 'string' && author.length > 0);
  const evidence = rawEvidence.filter(({ author }) =>
    typeof author === 'string' && author.length > 0);
  const byAuthor = new Map();
  for (const item of evidence) {
    if (!byAuthor.has(item.author)) byAuthor.set(item.author, []);
    byAuthor.get(item.author).push(item);
  }
  const roleSections = await mapBounded(
    [...byAuthor.keys()].sort(),
    MAX_CONCURRENCY,
    (login) => fetchRole(repo, login),
  );
  const roles = new Map(
    roleSections.flatMap((section) => section.items)
      .map((role) => [role.login, role]),
  );
  const items = [...byAuthor.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([login, authorEvidence]) => ({
      login,
      roleName: roles.get(login)?.roleName ?? null,
      permission: roles.get(login)?.permission ?? null,
      evidence: authorEvidence.sort((left, right) =>
        compareText(
          `${left.kind}\0${left.prNumber ?? left.issueNumber ?? 0}\0${left.id ?? ''}`,
          `${right.kind}\0${right.prNumber ?? right.issueNumber ?? 0}\0${right.id ?? ''}`,
        )),
    }));
  const dependencies = [
    openPrs,
    reviewEvidence,
    unresolvedThreads,
    queue.section,
    identityComplete
      ? completeSection([])
      : incompleteSection(
        'AUTHOR_IDENTITY_OPAQUE',
        'one or more author-verification records omitted an author identity',
      ),
    ...roleSections,
  ];
  return dependencies.every((section) => section.complete)
    ? completeSection(items)
    : incompleteSection(
      'AUTHOR_VERIFICATION_INCOMPLETE',
      sectionError(dependencies, 'author verification evidence is incomplete'),
      items,
    );
}

function dependencySections(error) {
  return Object.fromEntries(
    SNAPSHOT_SECTIONS.map((name) => [
      name,
      incompleteSection('REPOSITORY_DEPENDENCY_FAILED', error),
    ]),
  );
}

function sourceId(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function sourceTimestamp(value) {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))) return null;
  // Date.parse accepts some invalid dates by moving them to the next month.
  return new Date(value).toISOString().slice(0, 19) === value.slice(0, 19) ? value : null;
}

const WAIT_ISSUE_QUERY = `
query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){issue(number:$number){__typename id number state}}
}`;
const WAIT_PR_QUERY = `
query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){pullRequest(number:$number){__typename id number state headRefOid baseRefName}}
}`;

async function fetchWaitReferences(repo, references, pullRequest = false) {
  if (!Array.isArray(references) || references.length > MAX_ITEMS
    || references.some((number) => !Number.isSafeInteger(number) || number < 1)) {
    return incompleteSection('WAIT_REFERENCES_INVALID', 'wait references must be positive issue or PR numbers');
  }
  const sections = await mapBounded([...new Set(references)].sort((a, b) => a - b), MAX_CONCURRENCY, async (number) => {
    try {
      const data = await repo.request.graphql(pullRequest ? WAIT_PR_QUERY : WAIT_ISSUE_QUERY, {
        owner: repo.owner, name: repo.name, number,
      });
      const node = data.repository?.[pullRequest ? 'pullRequest' : 'issue'];
      if (node?.__typename !== (pullRequest ? 'PullRequest' : 'Issue')
        || node.number !== number || sourceId(node.id) === null
        || !(pullRequest ? ['OPEN', 'CLOSED', 'MERGED'] : ['OPEN', 'CLOSED']).includes(node.state)
        || (pullRequest && (!/^[0-9a-f]{40}$/u.test(node.headRefOid)
          || typeof node.baseRefName !== 'string' || node.baseRefName.length === 0))) {
        return incompleteSection(pullRequest ? 'WAIT_PR_INVALID' : 'WAIT_ISSUE_INVALID',
          `wait ${pullRequest ? 'PR' : 'issue'} #${number} is missing or returned invalid typed facts`);
      }
      return completeSection([{
        number, nodeId: node.id, state: node.state,
        ...(pullRequest ? { headOid: node.headRefOid, baseRefName: node.baseRefName } : {}),
      }]);
    } catch (error) {
      return incompleteSection(pullRequest ? 'WAIT_PR_FETCH_FAILED' : 'WAIT_ISSUE_FETCH_FAILED',
        `wait #${number}: ${commandError(error)}`);
    }
  });
  return combineSections(sections);
}

function selectionSources(request, waits) {
  return {
    schema: 'autoloop.selection-sources/1',
    repository: request.repositorySource ?? null,
    issues: [...request.issueIds].sort(([a], [b]) => a - b).map(([number, nodeId]) => ({ number, nodeId })),
    approvals: request.approvals.sort((a, b) => a.issue - b.issue),
    roles: [...request.roles.values()].sort((a, b) => compareText(a.login, b.login)),
    waitIssues: waits[0], waitPullRequests: waits[1],
  };
}

export async function repositorySnapshotWithSources({
  root = process.cwd(), now = () => new Date().toISOString(), references = {},
} = {}) {
  const request = createScanRequest(root);
  const scannedAt = now();
  const [repoSection, tree] = await Promise.all([
    fetchRepo(request),
    Promise.resolve(fetchTree(request)),
  ]);
  if (!repoSection.complete) {
    const sections = dependencySections(repoSection.error.message);
    sections.repo = repoSection;
    sections.tree = tree;
    const waits = [0, 1].map(() => incompleteSection('REPOSITORY_DEPENDENCY_FAILED', repoSection.error.message));
    return { snapshot: createSnapshot({ scannedAt, sections }), sources: selectionSources(request, waits) };
  }
  const repo = { ...repoSection.items[0], request };
  const waitReads = Promise.all([
    fetchWaitReferences(repo, references?.issues ?? []),
    fetchWaitReferences(repo, references?.pullRequests ?? [], true),
  ]);
  const [openPrs, openIssues, mergedPrs] = await Promise.all([
    fetchPullRequests(repo, ['OPEN']),
    fetchOpenIssues(repo),
    fetchPullRequests(repo, ['MERGED']),
  ]);
  const issueData = await fetchIssueBatches(
    repo,
    issueBatchRequests(openPrs, openIssues, mergedPrs),
  );
  const [queue, lifecycleMarkers] = await Promise.all([
    fetchQueue(openIssues, repo, issueData),
    fetchLifecycleMarkers(openPrs, openIssues, mergedPrs, repo, issueData),
  ]);
  const blockedIssues = derivedIssueSection(openIssues, 'loop-blocked');
  const [unresolvedReviewThreads, reviewEvidence] = await Promise.all([
    fetchUnresolvedThreads(openPrs, repo),
    fetchReviewEvidence(openPrs, repo),
  ]);
  const authorVerification = await fetchAuthorVerification(
    openPrs,
    reviewEvidence,
    unresolvedReviewThreads,
    queue,
    repo,
  );
  const snapshot = createSnapshot({
    scannedAt,
    sections: {
      repo: repoSection,
      tree,
      openPrs,
      lifecycleMarkers,
      queue: queue.section,
      blockedIssues,
      openIssues,
      mergedPrs,
      unresolvedReviewThreads,
      authorVerification,
    },
  });
  return { snapshot, sources: selectionSources(request, await waitReads) };
}

export async function repositorySnapshot({ root = process.cwd(), now } = {}) {
  return (await repositorySnapshotWithSources({ root, now })).snapshot;
}

function focusSection(section, predicate) {
  const items = section.items.filter(predicate);
  return section.complete
    ? completeSection(items)
    : incompleteSection(section.error.code, section.error.message, items);
}

function focusAuthorVerification(section, number, issueNumber) {
  const items = section.items
    .map((author) => ({
      ...author,
      evidence: author.evidence.filter((item) =>
        item.prNumber === number
        || (
          item.kind === 'queue-label'
          && Number.isSafeInteger(issueNumber)
          && item.issueNumber === issueNumber
        )),
    }))
    .filter((author) => author.evidence.length > 0);
  return section.complete
    ? completeSection(items)
    : incompleteSection(section.error.code, section.error.message, items);
}

function focusPr(snapshot, number) {
  const issueNumber = [
    ...snapshot.sections.openPrs.items,
    ...snapshot.sections.mergedPrs.items,
  ]
    .find((pr) => pr.number === number && pr.ownership === 'loop')
    ?.issue;
  const sections = {
    ...snapshot.sections,
    openPrs: focusSection(snapshot.sections.openPrs, (pr) => pr.number === number),
    mergedPrs: focusSection(snapshot.sections.mergedPrs, (pr) => pr.number === number),
    lifecycleMarkers: focusSection(
      snapshot.sections.lifecycleMarkers,
      (marker) => marker.issueNumber === issueNumber,
    ),
    unresolvedReviewThreads: focusSection(
      snapshot.sections.unresolvedReviewThreads,
      (thread) => thread.prNumber === number,
    ),
    authorVerification: focusAuthorVerification(
      snapshot.sections.authorVerification,
      number,
      issueNumber,
    ),
  };
  return createSnapshot({ scannedAt: snapshot.scannedAt, sections });
}

// Only the external GitHub boundary is replaced. Git and the scan run unchanged.
async function fakeScanGitHub() {
  const fs = await import('node:fs');
  const fixture = JSON.parse(fs.readFileSync(process.env.SCAN_FIXTURE, 'utf8'));
  const repo = fixture.roots[process.cwd()];
  const args = process.argv.slice(2);
  const requireFact = (passed, message) => { if (!passed) throw new Error(message); };
  requireFact(repo, 'request used an unrelated cwd');
  requireFact(process.env.GH_HOST === repo.host, 'request used an ambient host');
  requireFact(process.env.GH_REPO === `${repo.host}/fixtures/${repo.name}`, 'request used an ambient repository');
  requireFact(!Object.keys(process.env).some((key) => key.startsWith('GIT_') && ![
    'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_NO_REPLACE_OBJECTS', 'GIT_NO_LAZY_FETCH', 'GIT_OPTIONAL_LOCKS',
  ].includes(key)), 'request retained a Git override');
  requireFact(process.env.GIT_NO_LAZY_FETCH === '1', 'request did not fix the no-lazy-fetch control');
  const page = (nodes, cursor = null) => ({ nodes, pageInfo: { hasNextPage: cursor !== null, endCursor: cursor } });
  const at = '2026-01-01T00:00:00Z';
  const event = (number, query) => ({
    __typename: number === 20 && process.env.SCAN_CASE === 'unlabeled-parent' ? 'UnlabeledEvent' : 'LabeledEvent',
    ...(number !== 9 && query.includes('LabeledEvent{id ') ? { id: `${repo.name}-E${number}` } : {}),
    actor: { login: number === 20 && process.env.SCAN_CASE === 'changed-parent' ? 'other' : 'maintainer' },
    createdAt: number === 7 && process.env.SCAN_CASE === 'invalid-date' ? '2026-02-30T00:00:00Z' : at,
    label: { name: 'loop-ready' },
  });
  const issue = (number) => ({
    ...(number !== 9 ? { id: `${repo.name}-I${number}` } : {}), number, title: `issue ${number}`,
    body: number === 8 ? '<!-- autoloop-repair-v1 ' + JSON.stringify({
      parent: 20, parentLabeledBy: 'maintainer', parentLabeledAt: at, depth: 1, blocksParent: true,
    }) + ' -->' : number === 7 ? '## Blocked by\n- #20' : 'body',
    updatedAt: at, lastEditedAt: null,
    labels: number === 7 ? page([], 'labels-7') : page([{ name: number === 8 ? 'loop-repair' : 'loop-ready' }]),
  });
  const respond = (value) => process.stdout.write(JSON.stringify(value));
  if (args[0] === 'repo') {
    requireFact(args[2] === `${repo.host}/fixtures/${repo.name}`, 'repo view was not explicitly bound');
    respond({ nameWithOwner: process.env.SCAN_CASE === 'wrong-repo' ? 'fixtures/other' : `fixtures/${repo.name}`,
      defaultBranchRef: process.env.SCAN_CASE === 'missing-branch' ? null : { name: 'main' },
      ...(process.env.SCAN_CASE !== 'missing-repo-id' && args.at(-1).split(',').includes('id') ? { id: `${repo.name}-R` } : {}) });
    return;
  }
  requireFact(args.includes('--hostname') && args[args.indexOf('--hostname') + 1] === repo.host,
    'API host was not explicitly bound');
  if (args.some((arg) => arg.endsWith('/permission'))) {
    requireFact(args.includes(`repos/fixtures/${repo.name}/collaborators/maintainer/permission`), 'permission repository changed');
    respond({ permission: 'write', role_name: process.env.SCAN_CASE === 'missing-role' ? null : 'maintain',
      user: { login: 'maintainer', ...(process.env.SCAN_CASE !== 'missing-user-id' ? { id: repo.userId } : {}) } });
    return;
  }
  const { query, variables: v } = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (v.owner !== undefined) requireFact(v.owner === 'fixtures' && v.name === repo.name, 'GraphQL repository changed');
  if (v.id !== undefined) requireFact(v.id.startsWith(`${repo.name}-`), 'node continuation changed repository');
  // One transient external error exercises the real retry path in each root.
  if (query.includes('issues(states:OPEN') && !v.cursor) {
    const retry = `${process.env.SCAN_FIXTURE}.${repo.name}.retry`;
    if (!fs.existsSync(retry)) {
      fs.writeFileSync(retry, 'retried');
      process.stderr.write('HTTP 502 fixture failure'); process.exitCode = 1; return;
    }
  }
  let repository;
  if (query.includes('issues(states:OPEN')) repository = { issues: v.cursor ? page([issue(9)]) : page([issue(7), issue(8)], 'issues-next') };
  else if (query.includes('node(id:$id)')) {
    respond({ data: { node: { labels: page([{ name: 'loop-ready' }]) } } }); return;
  }
  else if (query.includes('repair: issue')) repository = {
    repair: { ...(query.includes('repair: issue(number:$number){id') ? { id: `${repo.name}-I8` } : {}), viewerDidAuthor: true },
    parent: { ...(query.includes('parent: issue(number:$parent){id') ? { id: `${repo.name}-I20` } : {}),
      state: 'CLOSED', stateReason: 'COMPLETED', lastEditedAt: null, labels: page([{ name: 'loop-ready' }]) },
  };
  else if (/i\d+:issue/u.test(query)) {
    repository = {};
    for (const [, alias, raw] of query.matchAll(/(i(\d+)):issue/gu)) {
      const number = Number(raw);
      repository[alias] = {
        __typename: 'Issue', number, state: 'CLOSED', comments: page([]),
        timelineItems: number === 7 ? page([event(1, query)], 'timeline-next') : page([event(number, query)]),
      };
    }
  }
  else if (query.includes('timelineItems(')) repository = { issue: { timelineItems: page([event(v.number, query)]) } };
  else if (query.includes('pullRequests(states:')) repository = { pullRequests: page(v.states.includes('OPEN') ? [{
    id: `${repo.name}-P40`, number: 40, title: 'delivered', body: 'Closes #7', isDraft: false,
    headRefName: 'feat/gh-7-fixture', headRefOid: 'a'.repeat(40), baseRefName: 'main',
    mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', mergedAt: null, updatedAt: at,
    author: { login: 'maintainer' }, headRepository: { nameWithOwner: `fixtures/${repo.name}` },
    files: page([{ path: 'src/a.mjs' }], 'files-next'),
    commits: { nodes: [{ commit: { oid: 'a'.repeat(40), statusCheckRollup: {
      state: 'SUCCESS', contexts: page([], 'checks-next'),
    } } }] },
  }] : []) };
  else if (query.includes('files(first:100,after:')) repository = { pullRequest: { files: page([{ path: 'src/b.mjs' }]) } };
  else if (query.includes('object(oid:')) repository = { object: { statusCheckRollup: { contexts: page([]) } } };
  else if (query.includes('reviewThreads(')) repository = { pullRequest: { reviewThreads: page([]) } };
  else if (query.includes('reviews(')) repository = { pullRequest: { reviews: page([]) } };
  else if (query.includes('comments(')) repository = { pullRequest: { comments: page([]) }, issue: { comments: page([]) } };
  else if (query.includes('pullRequest(number:')) repository = { pullRequest: v.number === 404 ? null : {
    __typename: v.number === 405 ? 'Issue' : 'PullRequest',
    ...(v.number !== 409 ? { id: `${repo.name}-P${v.number}` } : {}), number: v.number === 408 ? 30 : v.number,
    state: v.number === 407 ? 'UNKNOWN' : v.number === 31 ? 'CLOSED' : v.number === 32 ? 'MERGED' : 'OPEN',
    headRefOid: v.number === 406 ? null : 'b'.repeat(40), baseRefName: v.number === 410 ? null : 'main',
  } };
  else if (query.includes('issue(number:')) repository = { issue: v.number === 404 ? null : {
    __typename: v.number === 405 ? 'PullRequest' : 'Issue',
    ...(v.number !== 409 ? { id: `${repo.name}-I${v.number}` } : {}), number: v.number === 408 ? 20 : v.number,
    state: v.number === 407 ? 'UNKNOWN' : v.number === 20 ? 'CLOSED' : 'OPEN',
  } };
  else throw new Error('unexpected GitHub read');
  respond({ data: { repository } });
}

async function noFetchSelfTest() {
  const assert = (await import('node:assert/strict')).default;
  const { lstatSync, readdirSync } = await import('node:fs');
  const scratch = mkdtempSync(join(tmpdir(), 'autoloop-scan-promisor-'));
  const name = 'request Git reads refuse missing promised objects; fetchTree status already prevents the HEAD bypass';
  const previous = process.env.GIT_NO_LAZY_FETCH;
  try {
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_LAZY_FETCH: '0' };
    const git = (root, args) => execFileSync('git', ['-C', root, ...args],
      { env, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const source = join(scratch, 'source'); mkdirSync(source); git(source, ['init', '-q', '-b', 'main']);
    writeFileSync(join(source, 'fixture.txt'), 'public promised fixture\n'); git(source, ['add', 'fixture.txt']);
    git(source, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'promised fixture']);
    git(source, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
    const missing = git(source, ['rev-parse', 'HEAD']); const helper = join(scratch, 'local-transport.mjs');
    writeFileSync(helper, `import {writeFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';
      writeFileSync(process.argv[2],'local transport invoked\\n');
      const result=spawnSync(process.argv[3],[process.argv[4]],{stdio:'inherit'});process.exit(result.status??1);\n`);
    const objectBytes = (directory) => readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => total
      + (entry.isDirectory() ? objectBytes(join(directory, entry.name)) : lstatSync(join(directory, entry.name)).size), 0);
    const fixture = (name) => {
      const root = join(scratch, name); mkdirSync(root); git(root, ['init', '-q', '-b', 'main']);
      const marker = join(scratch, name + '.marker');
      git(root, ['remote', 'add', 'origin', 'https://github.com/fixtures/scan.git']);
      git(root, ['config', 'protocol.ext.allow', 'always']);
      git(root, ['config', 'remote.fixture-promisor.url', `ext::${process.execPath} ${helper} ${marker} %S ${source}`]);
      git(root, ['config', 'remote.fixture-promisor.promisor', 'true']);
      // A new ref points at a real commit held only by the local source.
      // No existing fixture object is deleted to create this missing object.
      writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), missing + '\n');
      assert.throws(() => git(root, ['--no-lazy-fetch', 'cat-file', '-e', missing])); assert.equal(existsSync(marker), false);
      return { root, marker, objects: join(root, '.git', 'objects') };
    };
    const control = fixture('ordinary'); const controlBytes = objectBytes(control.objects);
    assert.equal(git(control.root, ['rev-parse', '--verify', 'HEAD^{commit}']), missing);
    assert(existsSync(control.marker)); assert(objectBytes(control.objects) > controlBytes);
    const test = fixture('checked'); const before = objectBytes(test.objects);
    process.env.GIT_NO_LAZY_FETCH = '1'; const request = createScanRequest(test.root);
    const tree = fetchTree(request);
    assert.equal(tree.complete, false); assert.equal(tree.error.code, 'TREE_FETCH_FAILED');
    assert.equal(existsSync(test.marker), false); assert.equal(objectBytes(test.objects), before);
    let refused = false; try { request.gitText(['rev-parse', '--verify', 'HEAD^{commit}']); } catch { refused = true; }
    assert.deepEqual({ refused, transport: existsSync(test.marker), unchanged: objectBytes(test.objects) === before },
      { refused: true, transport: false, unchanged: true });
    return [[name, true]];
  } catch (error) {
    console.error(`FAIL ${name}: ${error.stack}`); return [[name, false]];
  } finally {
    if (previous === undefined) delete process.env.GIT_NO_LAZY_FETCH; else process.env.GIT_NO_LAZY_FETCH = previous;
    console.log(`Retained scan promisor fixture: ${scratch}`);
  }
}

async function sourceSelfTest() {
  const scratch = mkdtempSync(join(tmpdir(), 'autoloop-scan-sources-'));
  const checks = [];
  try {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
    env.GIT_CONFIG_NOSYSTEM = '1'; env.GIT_CONFIG_GLOBAL = '/dev/null';
    const roots = {};
    for (const [name, host, userId] of [['alpha', 'github.com', 71], ['beta', 'github.example.test', 72]]) {
      const root = join(scratch, name);
      mkdirSync(root);
      const git = (args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      git(['init', '--quiet']);
      git(['symbolic-ref', 'HEAD', `refs/heads/${name}`]);
      git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgsign=false',
        'commit', '--quiet', '--allow-empty', '-m', 'scan fixture']);
      git(['remote', 'add', 'origin', `https://${host}/fixtures/${name}.git`]);
      writeFileSync(join(root, 'fixture.txt'), 'baseline\n');
      writeFileSync(join(root, '.gitattributes'), 'fixture.txt filter=fixture\n');
      git(['add', 'fixture.txt', '.gitattributes']);
      git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'filter fixture']);
      const marker = join(scratch, `${name}-filter-marker`); const filter = join(scratch, `${name}-filter.mjs`);
      writeFileSync(filter, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)}, 'invoked');process.stdin.pipe(process.stdout);\n`, { mode: 0o700 });
      const included = join(scratch, `${name}-included.config`);
      git(['config', '--file', included, 'filter.fixture.clean', filter]);
      git(['config', `includeIf.onbranch:${name}.path`, included]);
      writeFileSync(join(root, 'fixture.txt'), 'changed!\n');
      utimesSync(join(root, 'fixture.txt'), new Date(), new Date(Date.now() + 2000));
      git(['status', '--porcelain=v1']);
      if (!existsSync(marker)) throw new Error('The ordinary scan fixture status must invoke its real filter.');
      renameSync(marker, join(scratch, `${name}-retained-control-marker`));
      roots[realpathSync(root)] = { name, host, userId, filterMarker: marker, headOid: git(['rev-parse', 'HEAD']).trim() };
    }
    const bin = join(scratch, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), `#!${process.execPath}\n(${fakeScanGitHub.toString()})().catch(error => { console.error(error); process.exitCode = 1; });\n`, { mode: 0o700 });
    const manifest = join(scratch, 'fixture.json'); writeFileSync(manifest, JSON.stringify({ roots }));
    const runner = `
      import assert from 'node:assert/strict';
      import {existsSync} from 'node:fs';
      const scan = await import(${JSON.stringify(import.meta.url)});
      const {verifySnapshot} = await import(${JSON.stringify(new URL('./snapshot-contract.mjs', import.meta.url).href)});
      const scanSnapshotValid = snapshot => verifySnapshot(snapshot) && Object.values(snapshot.sections).every(section => section.complete);
      const roots = JSON.parse(process.env.SCAN_ROOTS);
      const cwd = process.cwd();
      process.chdir = () => { assert.fail('scan must not call process.chdir'); };
      const now = () => '2026-01-01T00:00:00.000Z';
      assert.equal(typeof scan.repositorySnapshotWithSources, 'function', 'source provider must exist');
      const results = await Promise.all(roots.map(([root]) => scan.repositorySnapshotWithSources({
        root, now, references: {issues:[20,21],pullRequests:[30,31,32]},
      })));
      assert.equal(process.cwd(), cwd, 'scan must not change the global cwd');
      for (const [index, {snapshot,sources}] of results.entries()) {
        const [root,repo] = roots[index];
        assert.equal(scanSnapshotValid(snapshot), true, JSON.stringify(snapshot.sections));
        assert.equal(snapshot.sections.tree.items[0].branch, repo.name);
        assert.equal(snapshot.sections.tree.items[0].headOid, repo.headOid);
        assert.deepEqual(snapshot.sections.tree.items[0].dirtyEntries, [' M fixture.txt']);
        assert.equal(existsSync(repo.filterMarker), false, 'Mandatory fresh scan must not execute a configured clean driver');
        assert.deepEqual(snapshot.sections.openPrs.items[0].files, ['src/a.mjs','src/b.mjs']);
        assert.deepEqual(sources.repository, {host:repo.host,owner:'fixtures',name:repo.name,nodeId:repo.name+'-R'});
        assert.deepEqual(sources.issues, [7,8,9].map(number=>({number,nodeId:number===9?null:repo.name+'-I'+number})));
        assert.deepEqual(sources.approvals, [
          {issue:7,issueNodeId:repo.name+'-I7',approvalIssue:7,approvalIssueNodeId:repo.name+'-I7',
            eventId:repo.name+'-E7',actorLogin:'maintainer',createdAt:'2026-01-01T00:00:00Z',kind:'loop-ready'},
          {issue:8,issueNodeId:repo.name+'-I8',approvalIssue:20,approvalIssueNodeId:repo.name+'-I20',
            eventId:repo.name+'-E20',actorLogin:'maintainer',createdAt:'2026-01-01T00:00:00Z',kind:'repair-parent'},
          {issue:9,issueNodeId:null,approvalIssue:9,approvalIssueNodeId:null,
            eventId:null,actorLogin:'maintainer',createdAt:'2026-01-01T00:00:00Z',kind:'loop-ready'},
        ]);
        assert.deepEqual(sources.roles, [{login:'maintainer',userId:repo.userId,permission:'write',roleName:'maintain'}]);
        assert.equal(sources.waitIssues.complete,true);
        assert.deepEqual(sources.waitIssues.items,[{number:20,nodeId:repo.name+'-I20',state:'CLOSED'},
          {number:21,nodeId:repo.name+'-I21',state:'OPEN'}]);
        assert.equal(sources.waitPullRequests.complete,true);
        assert.deepEqual(sources.waitPullRequests.items,[30,31,32].map(number=>({number,nodeId:repo.name+'-P'+number,
          state:number===31?'CLOSED':number===32?'MERGED':'OPEN',headOid:'b'.repeat(40),baseRefName:'main'})));
        const legacy = await scan.repositorySnapshot({root,now});
        assert.deepEqual(legacy,snapshot,'legacy provider must return exactly the same snapshot');
        assert.equal(JSON.stringify(snapshot).includes('nodeId'),false);
        assert.equal(JSON.stringify(snapshot).includes('eventId'),false);
      }
      const root = roots[0][0];
      for (const number of [404,405,407,408,409]) {
        const {sources} = await scan.repositorySnapshotWithSources({root,now,references:{issues:[number],pullRequests:[number]}});
        assert.equal(sources.waitIssues.complete,false);
        assert.deepEqual(sources.waitIssues.items,[]);
        assert.equal(sources.waitPullRequests.complete,false);
        assert.deepEqual(sources.waitPullRequests.items,[]);
      }
      for (const number of [406,410]) {
        const malformed = await scan.repositorySnapshotWithSources({root,now,references:{pullRequests:[number]}});
        assert.equal(malformed.sources.waitPullRequests.complete,false);
        assert.deepEqual(malformed.sources.waitPullRequests.items,[]);
      }
      const invalid = await scan.repositorySnapshotWithSources({root,now,references:{issues:[0],pullRequests:['31']}});
      assert.equal(invalid.sources.waitIssues.complete,false);
      assert.equal(invalid.sources.waitPullRequests.complete,false);
      for (const testCase of ['wrong-repo','missing-branch','missing-repo-id','missing-role','missing-user-id',
        'changed-parent','unlabeled-parent','invalid-date']) {
        process.env.SCAN_CASE = testCase;
        const result = await scan.repositorySnapshotWithSources({root,now});
        if (testCase === 'wrong-repo' || testCase === 'missing-branch') {
          assert.equal(result.snapshot.sections.repo.complete,false);
          assert.equal(result.sources.repository,null);
          assert.equal(result.sources.waitIssues.complete,false);
        } else if (testCase === 'missing-repo-id') {
          assert.equal(result.sources.repository.nodeId,null);
          assert.equal(result.snapshot.sections.repo.complete,true);
        } else if (testCase === 'missing-role' || testCase === 'missing-user-id') {
          assert.equal(result.snapshot.sections.authorVerification.complete,false);
          assert.equal(result.sources.roles[0][testCase === 'missing-role' ? 'roleName' : 'userId'],null);
        } else {
          const approval = result.sources.approvals.find(item=>item.issue===(testCase==='invalid-date'?7:8));
          if (testCase === 'invalid-date') assert.equal(approval.createdAt,null);
          else {
            assert.equal(approval.eventId,null);
            assert.equal(approval.actorLogin,null);
            assert.equal(approval.createdAt,null);
          }
        }
      }
      delete process.env.SCAN_CASE;
      const {execFileSync} = await import('node:child_process');
      const tool = ${JSON.stringify(fileURLToPath(import.meta.url))};
      const cli = JSON.parse(execFileSync(process.execPath,[tool],{cwd:root,env:process.env,encoding:'utf8'}));
      const legacy = await scan.repositorySnapshot({root,now:()=>cli.scannedAt});
      assert.deepEqual(cli,legacy,'legacy CLI and API must use the same snapshot');
      const focused = JSON.parse(execFileSync(process.execPath,[tool,'--pr','40'],{cwd:root,env:process.env,encoding:'utf8'}));
      assert.equal(verifySnapshot(focused),true);
      assert.deepEqual(focused.sections.openPrs.items.map(item=>item.number),[40]);
      assert.equal(Object.hasOwn(cli,'sources'),false);
      for (const [,repo] of roots) assert.equal(existsSync(repo.filterMarker),false,'CLI and continuation scans must keep filters disabled');
      console.log('root/source integration OK');
    `;
    const runEnv = { ...env, PATH: `${bin}:${env.PATH}`, SCAN_FIXTURE: manifest, SCAN_ROOTS: JSON.stringify(Object.entries(roots)),
      GIT_DIR: join(scratch, 'beta', '.git'), GIT_WORK_TREE: join(scratch, 'beta'), GIT_NO_LAZY_FETCH: '0',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'remote.origin.url', GIT_CONFIG_VALUE_0: 'https://wrong.test/wrong/repo',
      GH_REPO: 'wrong.test/wrong/repo', GH_HOST: 'wrong.test' };
    try {
      execFileSync(process.execPath, ['--input-type=module', '-e', runner], {
        cwd: scratch, env: runEnv, encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024,
      });
      checks.push(['interleaved explicit roots retain source IDs, pagination, typed waits and exact legacy snapshots', true]);
    } catch (error) {
      console.error(error.stderr || error.message);
      checks.push(['interleaved explicit roots retain source IDs, pagination, typed waits and exact legacy snapshots', false]);
    }
  } finally {
    // The task permits cleanup of these newly created, test-owned fixtures only.
    try { rmSync(scratch, { recursive: true, force: true }); }
    catch (error) { console.error(`Retained scan fixtures ${scratch}: ${error.message}`); }
  }
  return checks;
}

async function selfTest() {
  const prs = CLAIM_CONTRACT_FIXTURES.map((fixture, index) => ({
    number: index + 1,
    headRefName: fixture.branch,
    body: fixture.body,
    isDraft: index === 0,
    headRepository: 'owner/repo',
  }));
  prs.push({
    number: prs.length + 1,
    headRefName: 'feat/gh-77-fork',
    body: 'Closes #77',
    isDraft: true,
    headRepository: 'fork/repo',
  });
  const { loopOwned, human } = classifyPrs(prs, 'owner/repo');
  const provenance = labelProvenance([
    { event: 'labeled', label: { name: 'loop-ready' }, actor: { login: 'a' }, created_at: 't1' },
    { event: 'labeled', label: { name: 'loop-blocked' }, actor: { login: 'x' }, created_at: 't2' },
    { event: 'labeled', label: { name: 'loop-ready' }, actor: { login: 'b' }, created_at: 't3' },
  ]);
  const blocked = blockedByIssueNumbers('body\n## Blocked by\n- #12\n- #34\n\n## Next\n#99');
  const expectedIssues = CLAIM_CONTRACT_FIXTURES
    .filter((fixture) => fixture.valid)
    .map((fixture) => fixture.issue);
  const issueBefore = issueSnapshotItem({
    number: 8,
    title: 'queued',
    body: 'before',
    updatedAt: '2026-01-01T00:00:00Z',
    lastEditedAt: '2026-01-01T00:00:00Z',
    labels: ['loop-ready'],
  });
  const issueAfter = issueSnapshotItem({ ...issueBefore, body: 'after' });
  const closedDependency = normalizeDependencyIssueSection(12, {
    __typename: 'Issue',
    number: 12,
    state: 'CLOSED',
  });
  const missingDependency = normalizeDependencyIssueSection(12, null);
  const nonIssueDependency = normalizeDependencyIssueSection(12, {
    __typename: 'PullRequest',
    number: 12,
    state: 'CLOSED',
  });
  const mismatchedDependency = normalizeDependencyIssueSection(12, {
    __typename: 'Issue',
    number: 13,
    state: 'CLOSED',
  });
  const unknownStateDependency = normalizeDependencyIssueSection(12, {
    __typename: 'Issue',
    number: 12,
    state: 'UNKNOWN',
  });
  const normalizedPr = normalizePullRequest({
    number: 3,
    title: 'loop',
    headRefName: 'feat/gh-8-loop',
    body: 'Closes #8',
    isDraft: true,
    headRepository: { nameWithOwner: 'owner/repo' },
    commits: {
      nodes: [{
        commit: {
          statusCheckRollup: {
            state: 'SUCCESS',
            contexts: {
              nodes: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED' }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      }],
    },
  }, undefined, 'owner/repo');
  const normalizedFork = normalizePullRequest({
    number: 4,
    title: 'fork',
    headRefName: 'feat/gh-9-fork',
    body: 'Closes #9',
    isDraft: true,
    headRepository: { nameWithOwner: 'fork/repo' },
  }, [], 'owner/repo');
  const normalizedReview = normalizeComment({
    id: 'review-1',
    author: { login: 'reviewer' },
    authorAssociation: 'MEMBER',
    body: 'change this',
    state: 'CHANGES_REQUESTED',
    submittedAt: '2026-01-01T00:00:00Z',
    url: 'https://example.test/review-1',
  }, 3, 'review');
  const normalizedThread = typeof normalizeReviewThread === 'function'
    ? normalizeReviewThread({
      id: 'thread-1',
      isOutdated: true,
      path: 'src/a.js',
      line: null,
      originalLine: 7,
    }, 3, [])
    : null;
  const malformedThread = normalizeReviewThread({
    id: 'thread-2',
    path: 'src/a.js',
    line: 7,
    originalLine: 7,
  }, 3, []);
  const partial = combineSections([
    completeSection([{ number: 1 }]),
    incompleteSection('PAGE_FETCH_FAILED', 'offline', [{ number: 2 }]),
  ]);
  const snapshot = createSnapshot({
    scannedAt: '2026-01-01T00:00:00.000Z',
    sections: Object.fromEntries(
      SNAPSHOT_SECTIONS.map((name) => [name, completeSection([])]),
    ),
  });
  const focusedSections = Object.fromEntries(
    SNAPSHOT_SECTIONS.map((name) => [name, completeSection([])]),
  );
  focusedSections.repo = completeSection([{
    owner: 'owner',
    name: 'repo',
    nameWithOwner: 'owner/repo',
    defaultBranch: 'main',
  }]);
  focusedSections.authorVerification = completeSection([{
    login: 'reviewer',
    roleName: 'write',
    permission: 'write',
    evidence: [
      {
        kind: 'review',
        id: 'review-3',
        prNumber: 3,
        author: 'reviewer',
        authorAssociation: 'MEMBER',
        body: 'change this',
        state: 'CHANGES_REQUESTED',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: null,
        url: 'https://example.test/review-3',
      },
      {
        kind: 'review',
        id: 'review-4',
        prNumber: 4,
        author: 'reviewer',
        authorAssociation: 'MEMBER',
        body: 'looks good',
        state: 'APPROVED',
        createdAt: '2026-01-01T00:00:01Z',
        updatedAt: null,
        url: 'https://example.test/review-4',
      },
    ],
  }]);
  focusedSections.openPrs = completeSection([{
    number: 3,
    title: 'loop PR',
    body: 'Closes #7',
    isDraft: false,
    reviewDecision: 'APPROVED',
    headRefName: 'feat/gh-7-loop-pr',
    headRefOid: 'a'.repeat(40),
    baseRefName: 'main',
    mergeStateStatus: 'CLEAN',
    mergeable: 'MERGEABLE',
    mergedAt: null,
    updatedAt: '2026-01-01T00:00:02Z',
    author: 'writer',
    headRepository: 'owner/repo',
    statusCheckState: 'SUCCESS',
    statusCheckRollup: [],
    files: [],
    issue: 7,
    orphanCandidate: false,
    ownership: 'loop',
  }]);
  focusedSections.authorVerification = completeSection([
    ...focusedSections.authorVerification.items,
    {
      login: 'labeler',
      roleName: 'maintain',
      permission: 'write',
      evidence: [{
        kind: 'queue-label',
        issueNumber: 7,
        author: 'labeler',
        authorAssociation: null,
        body: '',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: null,
        url: null,
      }],
    },
  ]);
  const focused = focusPr(createSnapshot({
    scannedAt: '2026-01-01T00:00:00.000Z',
    sections: focusedSections,
  }), 3);
  const graphQlProvenance = labelProvenance([{
    __typename: 'LabeledEvent',
    label: { name: 'loop-ready' },
    actor: { login: 'labeler' },
    createdAt: '2026-01-01T00:00:00Z',
  }]);
  const lifecycleBody = '<!-- autoloop-lifecycle-v1\n{"branch":"feat/gh-7-contract","intentSource":"invocation","issue":7,"issueBodyHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","mergePolicy":"manual","phase":"intent-recorded","planHash":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","plannedBaseOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","runIntentHash":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","selector":"native","v":1}\n-->';
  const lifecycleComment = {
    id: 'IC_lifecycle',
    author: { login: 'autoloop' },
    authorAssociation: 'MEMBER',
    viewerDidAuthor: true,
    body: lifecycleBody,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    url: 'https://example.test/issues/7#issuecomment-1',
  };
  const lifecycleSuccessorLink = {
    v: 1,
    rootCommentId: lifecycleComment.id,
    previousCommentId: lifecycleComment.id,
    previousBodyHash: createHash('sha256')
      .update(lifecycleBody)
      .digest('hex'),
    sequence: 1,
  };
  const lifecycleSuccessor = {
    ...lifecycleComment,
    id: 'IC_lifecycle_successor',
    body: serializeLifecycleSuccessor({
      ...parseLifecycleComment(lifecycleBody).marker,
      phase: 'local-claim',
      claimCommit: 'a'.repeat(40),
    }, lifecycleSuccessorLink),
    createdAt: '2026-01-01T00:00:01Z',
    updatedAt: '2026-01-01T00:00:01Z',
    url: 'https://example.test/issues/7#issuecomment-2',
  };
  const lifecycleChain = normalizeLifecycleMarkerSection(
    7,
    completeSection([lifecycleComment, lifecycleSuccessor]),
    new Set(['autoloop']),
  );
  const lifecycleTip = (issueNumber, phase, extra = {}) => normalizeLifecycleMarkerComment({
    ...lifecycleSuccessor,
    body: serializeLifecycleSuccessor({
      ...parseLifecycleComment(lifecycleBody).marker,
      claimCommit: 'a'.repeat(40),
      pr: 12,
      phase,
      ...extra,
    }, lifecycleSuccessorLink),
  }, issueNumber);
  const historicalTips = [
    lifecycleTip(7, 'terminal-record', { mergeOid: 'e'.repeat(40) }),
    lifecycleTip(8, 'terminal-refused', {
      refusal: { code: 'ARTIFACT_IDENTITY_MISMATCH', artifact: 'terminal-marker' },
    }),
    lifecycleTip(9, 'terminal-record', { mergeOid: 'e'.repeat(40) }),
    lifecycleTip(10, 'draft-pr'),
  ];
  const surfacedWhenOpenKnown = surfacedLifecycleMarkers(
    historicalTips,
    completeSection([{ number: 9 }]),
  ).map((item) => item.issueNumber);
  const surfacedWhenOpenUnknown = surfacedLifecycleMarkers(
    historicalTips,
    incompleteSection('PAGE_FETCH_FAILED', 'offline', [{ number: 9 }]),
  ).map((item) => item.issueNumber);
  const duplicateLifecycleSuccessor = normalizeLifecycleMarkerSection(
    7,
    completeSection([
      lifecycleComment,
      lifecycleSuccessor,
      { ...lifecycleSuccessor, id: 'IC_lifecycle_successor_duplicate' },
    ]),
    new Set(['autoloop']),
  );
  const forkedLifecycle = normalizeLifecycleMarkerSection(
    7,
    completeSection([
      lifecycleComment,
      lifecycleSuccessor,
      {
        ...lifecycleSuccessor,
        id: 'IC_lifecycle_fork',
        body: serializeLifecycleSuccessor({
          ...parseLifecycleComment(lifecycleBody).marker,
          phase: 'remote-claim',
          claimCommit: 'a'.repeat(40),
        }, lifecycleSuccessorLink),
      },
    ]),
    new Set(['autoloop']),
  );
  const disconnectedLifecycle = normalizeLifecycleMarkerSection(
    7,
    completeSection([
      lifecycleComment,
      {
        ...lifecycleSuccessor,
        body: serializeLifecycleSuccessor(
          parseLifecycleComment(lifecycleSuccessor.body).marker,
          {
            ...lifecycleSuccessorLink,
            previousBodyHash: 'f'.repeat(64),
          },
        ),
      },
    ]),
    new Set(['autoloop']),
  );
  const editedLifecycleRoot = normalizeLifecycleMarkerSection(
    7,
    completeSection([{
      ...lifecycleComment,
      lastEditedAt: '2026-01-01T00:00:05Z',
    }]),
    new Set(['autoloop']),
  );
  const editedLifecycleRootWithSuccessor = normalizeLifecycleMarkerSection(
    7,
    completeSection([
      { ...lifecycleComment, lastEditedAt: '2026-01-01T00:00:05Z' },
      { ...lifecycleSuccessor, lastEditedAt: null },
    ]),
    new Set(['autoloop']),
  );
  const editedLifecycleSuccessor = normalizeLifecycleMarkerSection(
    7,
    completeSection([
      { ...lifecycleComment, lastEditedAt: null },
      { ...lifecycleSuccessor, lastEditedAt: '2026-01-01T00:00:05Z' },
    ]),
    new Set(['autoloop']),
  );
  const normalizedLifecycle = typeof normalizeLifecycleMarkerComment === 'function'
    ? normalizeLifecycleMarkerComment(lifecycleComment, 7)
    : null;
  const trustedLifecycleAuthors = new Set(['autoloop']);
  const malformedLifecycle = typeof normalizeLifecycleMarkerSection === 'function'
    ? normalizeLifecycleMarkerSection(7, completeSection([{
      ...lifecycleComment,
      body: '<!-- autoloop-lifecycle-v1\nnot-json\n-->',
    }]), trustedLifecycleAuthors)
    : null;
  const duplicateLifecycle = typeof normalizeLifecycleMarkerSection === 'function'
    ? normalizeLifecycleMarkerSection(7, completeSection([
      lifecycleComment,
      { ...lifecycleComment, id: 'IC_lifecycle_2' },
    ]), trustedLifecycleAuthors)
    : null;
  const untrustedLifecycleLookalike = normalizeLifecycleMarkerSection(
    7,
    completeSection([
      lifecycleComment,
      {
        ...lifecycleComment,
        id: 'IC_untrusted',
        author: { login: 'outsider' },
        authorAssociation: 'NONE',
        body: '<!-- autoloop-lifecycle-v1\nnot-json\n-->',
      },
    ]),
    trustedLifecycleAuthors,
  );
  const untrustedLifecycleClaim = normalizeLifecycleMarkerSection(
    7,
    completeSection([{
      ...lifecycleComment,
      id: 'IC_untrusted_valid',
      author: { login: 'outsider' },
      authorAssociation: 'NONE',
    }]),
    trustedLifecycleAuthors,
  );
  const trustedLifecycleRoles = lifecycleTrustedAuthors([
    completeSection([
      { login: 'owner', roleName: 'admin', permission: 'admin' },
      { login: 'maintainer', roleName: 'maintain', permission: 'write' },
      { login: 'writer', roleName: 'write', permission: 'write' },
      { login: 'reader', roleName: 'read', permission: 'read' },
    ]),
  ], new Set());
  const currentWriterLifecycleRoles = lifecycleTrustedAuthors([
    completeSection([
      { login: 'writer', roleName: 'write', permission: 'write' },
    ]),
  ], new Set(['writer']));
  const boundRoleResponse = typeof normalizeRoleResponse === 'function'
    ? normalizeRoleResponse({
      permission: 'write',
      role_name: 'maintain',
      user: { id: 17, login: 'maintainer' },
    }, 'maintainer')
    : null;
  const mismatchedRoleResponse = typeof normalizeRoleResponse === 'function'
    ? normalizeRoleResponse({
      permission: 'admin',
      role_name: 'admin',
      user: { id: 18, login: 'attacker' },
    }, 'owner')
    : null;
  const incompleteRoleResponse = typeof normalizeRoleResponse === 'function'
    ? normalizeRoleResponse({
      permission: 'write',
      role_name: null,
      user: { id: 19, login: 'writer' },
    }, 'writer')
    : null;
  const lifecycleIssues = lifecycleIssueNumbers(
    completeSection([{ issue: 7 }, { issue: null }]),
    completeSection([{ number: 8 }]),
    completeSection([{ issue: 9 }, { issue: null }]),
  );
  const mergedFocusSections = Object.fromEntries(
    SNAPSHOT_SECTIONS.map((name) => [name, completeSection([])]),
  );
  mergedFocusSections.repo = completeSection([{
    owner: 'owner',
    name: 'repo',
    nameWithOwner: 'owner/repo',
    defaultBranch: 'main',
  }]);
  mergedFocusSections.mergedPrs = completeSection([
    {
      ...focusedSections.openPrs.items[0],
      number: 4,
      mergedAt: '2026-01-01T00:00:03Z',
    },
    {
      ...focusedSections.openPrs.items[0],
      number: 5,
      body: 'Closes #8',
      headRefName: 'feat/gh-8-loop-pr',
      issue: 8,
      mergedAt: '2026-01-01T00:00:04Z',
    },
  ]);
  mergedFocusSections.lifecycleMarkers = completeSection([normalizedLifecycle]);
  const focusedMerged = focusPr(createSnapshot({
    scannedAt: '2026-01-01T00:00:00.000Z',
    sections: mergedFocusSections,
  }), 4);
  const retried = [];
  const flaky = async (failures, error) => {
    let calls = 0;
    const value = await withCommandRetries(async () => {
      calls += 1;
      if (calls <= failures) throw error;
      return 'ok';
    }, [1, 1], async (ms) => { retried.push(ms); }).catch(() => 'threw');
    return { value, calls };
  };
  const blip = await flaky(2, Object.assign(new Error('gh: HTTP 502'), { stderr: '' }));
  const outage = await flaky(3, Object.assign(new Error('x'), { killed: true }));
  const denied = await flaky(1, Object.assign(new Error('gh: HTTP 401: Bad credentials'), {
    stderr: 'HTTP 401',
  }));
  // One aliased query per 25 issues replaced 469 single-issue reads (LFE,
  // 2026-09-28: 478 gh calls, 75 s per prime). Sections must not change.
  const batchRepo = { owner: 'o', name: 'r' };
  const commentNode = (id) => ({
    id, author: { login: 'autoloop' }, authorAssociation: 'OWNER', body: id,
    createdAt: 't', lastEditedAt: null, updatedAt: 't', url: 'u', viewerDidAuthor: true,
  });
  const labelEvent = { __typename: 'LabeledEvent', actor: { login: 'a' }, createdAt: 't', label: { name: 'loop-ready' } };
  const page = (nodes, next = null) => ({
    nodes, pageInfo: { hasNextPage: next !== null, endCursor: next },
  });
  const batchCalls = [];
  const fakeGraphql = async (query, variables) => {
    batchCalls.push({ query, variables });
    if (query.includes('i66:')) throw new Error('HTTP 502 after retries');
    if (variables.cursor === 'c1') {
      return { data: { repository: { issue: { comments: page([commentNode('c-101')]) } } } };
    }
    const repository = {};
    for (const [, alias, number] of query.matchAll(/(i(\d+)):issue/gu)) {
      const n = Number(number);
      if (n === 231) continue;
      repository[alias] = {
        ...(query.includes('comments(') ? { comments: page([commentNode(`c-${n}`)], n === 7 ? 'c1' : null) } : {}),
        ...(query.includes('timelineItems(') ? { timelineItems: page([labelEvent]) } : {}),
        ...(query.includes('state') ? { __typename: 'Issue', number: n, state: 'CLOSED' } : {}),
      };
    }
    return {
      data: { repository: { ...repository, ...(query.includes('i231:') ? { i231: null } : {}) } },
      errors: query.includes('i231:')
        ? [{ path: ['repository', 'i231'], message: 'Could not resolve to an Issue with the number of 231.' }]
        : undefined,
    };
  };
  let rejectedNumber = false;
  try { issueBatchQuery([{ number: '7) { x }', parts: ['comments'] }]); } catch { rejectedNumber = true; }
  const builtQuery = issueBatchQuery([
    { number: 7, parts: ['comments', 'timeline'] },
    { number: 12, parts: ['dependency'] },
  ]);
  const chunks = issueBatchChunks(Array.from({ length: 60 }, (unused, index) => ({
    number: index + 1, parts: ['comments'],
  })));
  const batched = await fetchIssueBatches(batchRepo, [
    { number: 7, parts: ['comments', 'timeline'] },
    { number: 8, parts: ['comments'] },
    { number: 12, parts: ['dependency'] },
    { number: 231, parts: ['dependency'] },
  ], { graphql: fakeGraphql });
  const failedBatch = await fetchIssueBatches(batchRepo, [
    ...Array.from({ length: 25 }, (unused, index) => ({ number: index + 42, parts: ['comments'] })),
    { number: 100, parts: ['comments'] },
  ], { graphql: fakeGraphql });
  // Flow 2026-10: delivered loop PRs on shared files conflicted each other.
  // The overlap check reads each open PR's changed paths from the scan.
  const filesCalls = [];
  const fakePrGraphql = async (query, variables) => {
    filesCalls.push({ query, variables });
    if (query.includes('files(first:100,after:$cursor)')) {
      return { repository: { pullRequest: { files: page([{ path: 'src/b/c.mjs' }]) } } };
    }
    return { repository: { pullRequests: page([{
      number: 3, title: 'loop', body: 'Closes #8', isDraft: false, headRefName: 'feat/gh-8-loop',
      headRefOid: 'a'.repeat(40), baseRefName: 'main', mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE',
      mergedAt: null, updatedAt: '2026-01-01T00:00:00Z', author: { login: 'autoloop' },
      headRepository: { nameWithOwner: 'o/r' },
      files: page([{ path: 'src/a.mjs' }, { path: 'src/a.mjs' }], 'f1'),
      commits: { nodes: [{ commit: { oid: 'a'.repeat(40), statusCheckRollup: null } }] },
    }]) } };
  };
  const withFiles = await fetchPullRequests({ owner: 'o', name: 'r', nameWithOwner: 'o/r' }, ['OPEN'], { graphql: fakePrGraphql });
  const checks = [
    ...await noFetchSelfTest(),
    ...await sourceSelfTest(),
    [
      'source approval timestamps retain API strings and reject invalid calendar dates',
      sourceTimestamp('2026-01-01T00:00:00Z') === '2026-01-01T00:00:00Z'
        && sourceTimestamp('2026-01-01T00:00:00.123Z') === '2026-01-01T00:00:00.123Z'
        && sourceTimestamp('2026-01-01T00:00:00.1234Z') === null
        && sourceTimestamp('2026-02-30T00:00:00Z') === null
        && sourceTimestamp('not-date') === null,
    ],
    [
      'the PR query fetches changed paths, pages past 100, and the normalized PR carries them sorted and unique',
      PULL_REQUESTS_QUERY.includes('files(first:100){nodes{path}pageInfo{hasNextPage endCursor}}')
        && withFiles.complete === true
        && withFiles.items.length === 1
        && JSON.stringify(withFiles.items[0].files) === '["src/a.mjs","src/b/c.mjs"]'
        && withFiles.items[0].ownership === 'loop'
        && filesCalls.length === 2
        && filesCalls[1].variables.cursor === 'f1'
        && JSON.stringify(normalizedPr.files) === '[]',
    ],
    [
      // A single 502 during prime used to end the run before any unit started.
      'transient gh reads retry with backoff; auth and bounded outages fail',
      blip.value === 'ok' && blip.calls === 3
        && outage.value === 'threw' && outage.calls === 3
        && denied.value === 'threw' && denied.calls === 1
        && retried.length === 4
        && transientCommandFailure({ message: 'x', stderr: 'read: connection reset by peer' })
        && !transientCommandFailure({ message: 'Could not resolve to an Issue', stderr: '' }),
    ],
    [
      'canonical ownership parser',
      loopOwned.map((pr) => pr.issue).join(',') === expectedIssues.join(',')
        && loopOwned[0].orphanCandidate === true
        && human.length === CLAIM_CONTRACT_FIXTURES.filter((fixture) => !fixture.valid).length + 1
        && human.at(-1).number === prs.length,
    ],
    [
      'last label provenance',
      provenance.labeledBy === 'b'
        && provenance.labeledAt === 't3'
        && labelProvenance([]) === null,
    ],
    [
      'the parent loop-ready event reads the newest label or unlabel',
      JSON.stringify(lastLoopReadyEvent([
        { __typename: 'LabeledEvent', label: { name: 'loop-ready' }, actor: { login: 'a' }, createdAt: 't1' },
        { __typename: 'UnlabeledEvent', label: { name: 'loop-ready' }, actor: { login: 'a' }, createdAt: 't2' },
        { __typename: 'LabeledEvent', label: { name: 'loop-blocked' }, actor: { login: 'x' }, createdAt: 't3' },
      ])) === JSON.stringify({ event: 'unlabeled', actor: 'a', at: 't2' })
        && lastLoopReadyEvent([]) === null,
    ],
    [
      'repair facts copy the marker as provenance and carry the live parent event',
      (() => {
        const marker = { parent: 248, parentLabeledBy: 'a', parentLabeledAt: 't1', depth: 1 };
        const facts = repairItemFacts({ ...marker, blocksParent: true }, [
          { __typename: 'LabeledEvent', label: { name: 'loop-ready' }, actor: { login: 'a' }, createdAt: 't1' },
        ], {
          repair: { viewerDidAuthor: true },
          parent: { state: 'CLOSED', stateReason: 'COMPLETED', lastEditedAt: 't0', labels: { nodes: [{ name: 'loop-ready' }, { name: 'loop-delivered' }] } },
        });
        return JSON.stringify(facts.provenance) === '{"labeledBy":"a","labeledAt":"t1"}'
          && JSON.stringify(facts.repair) === JSON.stringify({
            parent: 248,
            parentLabeledBy: 'a',
            parentLabeledAt: 't1',
            viewerDidAuthor: true,
            parentLastReadyEvent: { event: 'labeled', actor: 'a', at: 't1' },
            parentState: 'CLOSED',
            parentStateReason: 'COMPLETED',
            parentBlocked: false,
            parentDelivered: true,
            blocksParent: true,
            parentLastEditedAt: 't0',
          });
      })(),
    ],
    [
      'the parent\'s edit time is selected, and a missing one is not read as never edited',
      /parent: issue\(number:\$parent\)\{[^}]*\blastEditedAt\b/u.test(REPAIR_FACTS_QUERY)
        && repairItemFacts({ parent: 1, parentLabeledBy: 'a', parentLabeledAt: 't1' }, [], {
          repair: { viewerDidAuthor: true },
          parent: { state: 'OPEN', stateReason: null, labels: { nodes: [] } },
        }).repair.parentLastEditedAt === undefined,
    ],
    [
      'blocked-by section parsing',
      blocked.join(',') === '12,34'
        && blockedByIssueNumbers('no section #5').length === 0,
    ],
    [
      'dependency facts require an exact Issue identity and state',
      typeof normalizeDependencyIssueSection === 'function'
        && DEPENDENCY_ISSUE_QUERY.includes('__typename')
        && DEPENDENCY_ISSUE_QUERY.includes('state')
        && closedDependency.complete === true
        && closedDependency.items[0]?.number === 12
        && closedDependency.items[0]?.state === 'CLOSED'
        && [
          missingDependency,
          nonIssueDependency,
          mismatchedDependency,
          unknownStateDependency,
        ]
          .every((section) =>
            section.complete === false
            && section.error?.code === 'DEPENDENCY_ISSUE_INVALID'),
    ],
    ['durable body hash changes on edits', issueBefore.bodySha256 !== issueAfter.bodySha256],
    [
      'normalized loop PR carries claim',
      normalizedPr.issue === 8
        && normalizedPr.orphanCandidate === true
        && normalizedPr.statusCheckRollup.length === 1,
    ],
    [
      'normalized fork PR remains human-owned',
      normalizedFork.ownership === 'human'
        && normalizedFork.issue === null
        && normalizedFork.orphanCandidate === false,
    ],
    [
      'actionability fields survive normalization',
      normalizedReview.state === 'CHANGES_REQUESTED'
        && normalizedThread?.isOutdated === true,
    ],
    [
      'malformed thread facts cannot normalize to safe values',
      malformedThread.isOutdated === null
        && typeof validThreadConnectionItem === 'function'
        && validThreadConnectionItem({
          id: 'thread-2',
          isOutdated: false,
          path: 'src/a.js',
          line: 7,
          originalLine: 7,
          comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        }) === false,
    ],
    [
      'role lookup failures remain incomplete',
      typeof roleFailureSection === 'function'
        && roleFailureSection(new Error('HTTP 404: Not Found')).complete === false,
    ],
    [
      'GraphQL label provenance is recognized',
      graphQlProvenance?.labeledBy === 'labeler'
        && graphQlProvenance?.labeledAt === '2026-01-01T00:00:00Z',
    ],
    [
      'pre-PR issue lifecycle markers normalize with issue identity',
      normalizedLifecycle?.issueNumber === 7
        && normalizedLifecycle?.id === 'IC_lifecycle'
        && normalizedLifecycle?.body === lifecycleBody,
    ],
    [
      'malformed lifecycle marker candidates keep discovery incomplete',
      malformedLifecycle?.complete === false
        && malformedLifecycle?.error?.code === 'LIFECYCLE_MARKER_INVALID',
    ],
    [
      'identical duplicate lifecycle roots collapse deterministically',
      duplicateLifecycle?.complete === true
        && duplicateLifecycle.items.length === 1
        && duplicateLifecycle.items[0].id === 'IC_lifecycle',
    ],
    [
      'append-only lifecycle chain snapshots the logical tip and root',
      lifecycleChain.complete === true
        && lifecycleChain.items.length === 1
        && lifecycleChain.items[0].id === lifecycleComment.id
        && lifecycleChain.items[0].tipId === lifecycleSuccessor.id
        && lifecycleChain.items[0].sequence === 1
        && lifecycleChain.items[0].body === lifecycleSuccessor.body,
    ],
    [
      'identical lifecycle successor retries collapse deterministically',
      duplicateLifecycleSuccessor.complete === true
        && duplicateLifecycleSuccessor.items.length === 1
        && duplicateLifecycleSuccessor.items[0].sequence === 1,
    ],
    [
      'divergent lifecycle successor forks keep discovery incomplete',
      forkedLifecycle.complete === false
        && forkedLifecycle.error?.code === 'LIFECYCLE_MARKER_AMBIGUOUS',
    ],
    [
      'disconnected lifecycle successors keep discovery incomplete',
      disconnectedLifecycle.complete === false
        && disconnectedLifecycle.error?.code === 'LIFECYCLE_MARKER_INVALID',
    ],
    [
      'an unanchored edited lifecycle root keeps discovery incomplete',
      editedLifecycleRoot.complete === false
        && editedLifecycleRoot.error?.code === 'LIFECYCLE_MARKER_INVALID',
    ],
    [
      'a hash-anchored edited lifecycle root still resolves its tip',
      editedLifecycleRootWithSuccessor.complete === true
        && editedLifecycleRootWithSuccessor.items.length === 1
        && editedLifecycleRootWithSuccessor.items[0].tipId === lifecycleSuccessor.id,
    ],
    [
      'an edited lifecycle successor keeps discovery incomplete',
      editedLifecycleSuccessor.complete === false
        && editedLifecycleSuccessor.error?.code === 'LIFECYCLE_MARKER_INVALID',
    ],
    [
      'untrusted lifecycle lookalikes cannot wedge trusted recovery',
      untrustedLifecycleLookalike.complete === true
        && untrustedLifecycleLookalike.items.length === 1
        && untrustedLifecycleLookalike.items[0].author === 'autoloop',
    ],
    [
      'untrusted lifecycle claims have no durable authority',
      untrustedLifecycleClaim.complete === true
        && untrustedLifecycleClaim.items.length === 0,
    ],
    [
      'maintainer lifecycle authority excludes unrelated writers',
      [...trustedLifecycleRoles].sort().join(',') === 'maintainer,owner',
    ],
    [
      'the authenticated current writer can retain its own lifecycle authority',
      [...currentWriterLifecycleRoles].join(',') === 'writer',
    ],
    [
      'lifecycle comment discovery records current-viewer authorship',
      ISSUE_COMMENTS_QUERY.includes('viewerDidAuthor'),
    ],
    [
      'role responses bind permission evidence to the requested identity',
      boundRoleResponse?.login === 'maintainer'
        && boundRoleResponse?.roleName === 'maintain'
        && mismatchedRoleResponse === null
        && incompleteRoleResponse === null,
    ],
    // LFE, 2026-09-28: 45 markers of finished units were reconciled before every
    // selection. A terminal tip on a closed issue is done; one on an open issue,
    // or any non-terminal tip (a human-merge backfill), still surfaces.
    [
      'finished markers on closed issues are not surfaced; the rest are',
      surfacedWhenOpenKnown.join(',') === '9,10'
        && surfacedWhenOpenUnknown.join(',') === '7,8,9,10',
    ],
    [
      'merged loop PR issues remain discoverable after their issues close',
      lifecycleIssues.join(',') === '7,8,9',
    ],
    [
      'focused merged PR retains its lifecycle marker',
      focusedMerged.sections.lifecycleMarkers.items.length === 1
        && focusedMerged.sections.lifecycleMarkers.items[0].issueNumber === 7,
    ],
    [
      'focused merged PR excludes unrelated merged PRs',
      focusedMerged.sections.mergedPrs.items.length === 1
        && focusedMerged.sections.mergedPrs.items[0].number === 4,
    ],
    [
      'focused author evidence excludes other PRs',
      focused.sections.authorVerification.items.some((author) =>
        author.login === 'reviewer'
        && author.evidence.length === 1
        && author.evidence[0].prNumber === 3),
    ],
    [
      'focused author evidence retains matching queue provenance',
      focused.sections.authorVerification.items.length === 2
        && focused.sections.authorVerification.items.some((author) =>
          author.login === 'labeler'
          && author.evidence.length === 1
          && author.evidence[0].issueNumber === 7),
    ],
    [
      'partial combinations remain incomplete',
      partial.complete === false && partial.items.length === 2,
    ],
    [
      'batch requests merge an open issue\'s comments and timeline into one alias',
      JSON.stringify(issueBatchRequests(
        completeSection([]),
        completeSection([
          { number: 7, labels: ['loop-ready'], body: '## Blocked by\n- #3\n- #100000000000000000000' },
          { number: 9, labels: [], body: '' },
        ]),
        completeSection([{ issue: 5 }]),
      )) === JSON.stringify([
        { number: 3, parts: ['dependency'] },
        { number: 5, parts: ['comments'] },
        { number: 7, parts: ['comments', 'timeline'] },
        { number: 9, parts: ['comments'] },
      ]),
    ],
    [
      'a batch query aliases each issue with only its parts, and admits only integers',
      rejectedNumber
        && /i7:issue\(number:7\)\{comments\(first:100\)/u.test(builtQuery)
        && builtQuery.includes('timelineItems(first:100')
        && /i12:issue\(number:12\)\{__typename number state\}/u.test(builtQuery)
        && chunks.map((chunk) => chunk.length).join(',') === '25,25,10',
    ],
    [
      'batched first pages become the sections the per-issue path returns',
      JSON.stringify(batched.get(8).comments) === JSON.stringify(completeSection([commentNode('c-8')]))
        && JSON.stringify(batched.get(7).timeline) === JSON.stringify(completeSection([labelEvent]))
        && JSON.stringify(batched.get(12).dependency)
          === JSON.stringify(normalizeDependencyIssueSection(12, { __typename: 'Issue', number: 12, state: 'CLOSED' })),
    ],
    [
      'a next page continues per issue from the batched cursor',
      JSON.stringify(batched.get(7).comments)
        === JSON.stringify(completeSection([commentNode('c-7'), commentNode('c-101')]))
        && batchCalls.some(({ variables }) => variables.number === 7 && variables.cursor === 'c1'),
    ],
    [
      'an error on one alias fails only that issue',
      batched.get(231).dependency.complete === false
        && batched.get(231).dependency.error.code === 'DEPENDENCY_ISSUE_FETCH_FAILED'
        && batched.get(231).dependency.error.message.includes('Could not resolve')
        && batched.get(12).dependency.complete === true,
    ],
    // A batch that keeps failing (a timeout on a comment-heavy chunk) must not
    // blank its 25 issues every prime: its issues fall back to single reads.
    [
      'a failed batch leaves its issues to the per-issue path, and no other batch',
      [...Array(25).keys()].every((index) => !failedBatch.has(index + 42))
        && failedBatch.get(100).comments.complete === true,
    ],
    ['snapshot envelope verifies', verifySnapshot(snapshot)],
    [
      'every section is discriminated',
      SNAPSHOT_SECTIONS.every((name) =>
        Object.keys(snapshot.sections[name]).sort().join(',')
          === 'complete,error,items'),
    ],
  ];
  const failures = checks.filter(([, passed]) => !passed);
  for (const [name] of failures) console.error(`FAIL: ${name}`);
  console.log(
    failures.length
      ? `self-test FAILED (${failures.length}/${checks.length})`
      : `self-test OK (${checks.length} groups)`,
  );
  return failures.length === 0;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) return await selfTest() ? 0 : 1;
  const prIndex = args.indexOf('--pr');
  const prNumber = prIndex === -1 ? null : Number(args[prIndex + 1]);
  if (prIndex !== -1 && (!Number.isSafeInteger(prNumber) || prNumber < 1)) {
    console.error('FAIL scan: --pr requires a positive PR number');
    return 2;
  }
  try {
    const snapshot = await repositorySnapshot();
    if (prIndex !== -1) {
      writeStdoutSync(`${JSON.stringify(focusPr(snapshot, prNumber), null, 1)}\n`);
      return 0;
    }
    writeStdoutSync(`${JSON.stringify(snapshot, null, 1)}\n`);
    return 0;
  } catch (error) {
    const sections = Object.fromEntries(
      SNAPSHOT_SECTIONS.map((name) => [
        name,
        incompleteSection('SCAN_FAILED', commandError(error)),
      ]),
    );
    writeStdoutSync(`${JSON.stringify(createSnapshot({
      scannedAt: new Date().toISOString(),
      sections,
    }), null, 1)}\n`);
    return 0;
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
if (isMain) process.exit(await main());
