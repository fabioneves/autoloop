#!/usr/bin/env node

import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CLAIM_CONTRACT_FIXTURES, parseLoopClaim } from './claim-contract.mjs';
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
const limitCommand = createLimiter(MAX_CONCURRENCY);

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

const DEPENDENCY_ISSUE_QUERY = `
query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    issue(number:$number){
      __typename
      number
      state
    }
  }
}`;

const ISSUE_COMMENTS_QUERY = `
query($owner:String!,$name:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$name){
    issue(number:$number){
      comments(first:100,after:$cursor){
        nodes{
          id author{login} authorAssociation body createdAt lastEditedAt updatedAt url
          viewerDidAuthor
        }
        pageInfo{hasNextPage endCursor}
      }
    }
  }
}`;

const ISSUE_TIMELINE_QUERY = `
query($owner:String!,$name:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$name){
    issue(number:$number){
      timelineItems(
        first:100
        after:$cursor
        itemTypes:[LABELED_EVENT]
      ){
        nodes{
          __typename
          ... on LabeledEvent{
            actor{login}
            createdAt
            label{name}
          }
        }
        pageInfo{hasNextPage endCursor}
      }
    }
  }
}`;

const PULL_REQUESTS_QUERY = `
query($owner:String!,$name:String!,$states:[PullRequestState!],$cursor:String){
  repository(owner:$owner,name:$name){
    pullRequests(states:$states,first:100,after:$cursor,orderBy:{field:UPDATED_AT,direction:DESC}){
      nodes{
        id number title body isDraft reviewDecision headRefName headRefOid
        baseRefName mergeStateStatus mergeable mergedAt updatedAt
        author{login} headRepository{nameWithOwner}
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

async function jsonCommand(file, args, input = undefined) {
  return limitCommand(async () => {
    const stdout = await new Promise((resolve, reject) => {
      const child = execFile(file, args, {
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

async function ghJson(args, input = undefined) {
  return jsonCommand('gh', args, input);
}

async function ghGraphql(query, variables) {
  const response = await ghJson(
    ['api', 'graphql', '--input', '-'],
    JSON.stringify({ query, variables }),
  );
  if (Array.isArray(response.errors) && response.errors.length) {
    throw new Error(response.errors.map(({ message }) => message).join('; '));
  }
  if (!response.data) throw new Error('GraphQL response omitted data');
  return response.data;
}

function gitText(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20000,
    maxBuffer: 64 * 1024 * 1024,
  });
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
) {
  const value = pr && typeof pr === 'object' && !Array.isArray(pr) ? pr : {};
  const { claim, loopOwned } = loopOwnership(value, repositoryNameWithOwner);
  const commit = value.commits?.nodes?.at(-1)?.commit;
  const contexts = Array.isArray(statusContexts)
    ? statusContexts
    : commit?.statusCheckRollup?.contexts?.nodes ?? [];
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

async function fetchRepo() {
  try {
    const data = await ghJson(['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef']);
    const [owner, name] = String(data.nameWithOwner ?? '').split('/');
    if (!owner || !name) throw new Error('repository identity is unavailable');
    if (typeof data.defaultBranchRef?.name !== 'string') {
      throw new Error('repository default branch is unavailable');
    }
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

function fetchTree() {
  try {
    const dirtyEntries = gitText([
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ]).split('\0').filter(Boolean);
    return completeSection([{
      dirtyEntries,
      dirtyPaths: dirtyEntries.length,
      branch: gitText(['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
      headOid: gitText(['rev-parse', '--verify', 'HEAD^{commit}']).trim().toLowerCase(),
    }]);
  } catch (error) {
    return incompleteSection('TREE_FETCH_FAILED', commandError(error));
  }
}

async function fetchPullRequests(repo, states) {
  const section = await collectPaginated(async (cursor) => {
    const data = await ghGraphql(PULL_REQUESTS_QUERY, {
      owner: repo.owner,
      name: repo.name,
      states,
      cursor,
    });
    return connectionPage(data.repository?.pullRequests, 'pull requests');
  }, { maxPages: MAX_PAGES, maxItems: MAX_ITEMS });
  if (!states.includes('OPEN')) {
    const items = section.items
      .map((pr) => normalizePullRequest(pr, [], repo.nameWithOwner))
      .sort((left, right) => left.number - right.number);
    return section.complete
      ? completeSection(items)
      : incompleteSection(section.error.code, section.error.message, items);
  }
  const checks = await mapBounded(section.items, MAX_CONCURRENCY, async (pr) => ({
    pr,
    section: await fetchCheckContexts(repo, pr),
  }));
  const items = checks
    .map(({ pr, section: checkSection }) =>
      normalizePullRequest(pr, checkSection.items, repo.nameWithOwner))
    .sort((left, right) => left.number - right.number);
  const dependencies = [section, ...checks.map(({ section: value }) => value)];
  return dependencies.every((value) => value.complete)
    ? completeSection(items)
    : incompleteSection(
      'OPEN_PR_CHECKS_INCOMPLETE',
      sectionError(dependencies, 'open PR check evidence is incomplete'),
      items,
    );
}

async function fetchCheckContexts(repo, pr) {
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
    const data = await ghGraphql(CHECK_CONTEXTS_QUERY, {
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

async function fetchIssueLabels(issue) {
  let initial = true;
  return collectPaginated(async (cursor) => {
    if (initial) {
      initial = false;
      return connectionPage(issue.labels, `issue #${issue.number} labels`);
    }
    const data = await ghGraphql(ISSUE_LABELS_QUERY, {
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
    const data = await ghGraphql(DEPENDENCY_ISSUE_QUERY, {
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

async function fetchIssueComments(repo, issueNumber) {
  return collectPaginated(async (cursor) => {
    const data = await ghGraphql(ISSUE_COMMENTS_QUERY, {
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

async function fetchLifecycleMarkers(openPrs, openIssues, mergedPrs, repo) {
  const issueNumbers = lifecycleIssueNumbers(openPrs, openIssues, mergedPrs);
  const commentsByIssue = await mapBounded(
    issueNumbers,
    MAX_CONCURRENCY,
    async (issueNumber) => ({
      issueNumber,
      section: await fetchIssueComments(repo, issueNumber),
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
  const items = perIssue
    .flatMap((section) => section.items)
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
    const data = await ghGraphql(ISSUES_QUERY, {
      owner: repo.owner,
      name: repo.name,
      cursor,
    });
    return connectionPage(data.repository?.issues, 'open issues');
  }, { maxPages: MAX_PAGES, maxItems: MAX_ITEMS });
  const enriched = await mapBounded(base.items, MAX_CONCURRENCY, async (issue) => {
    const labels = await fetchIssueLabels(issue);
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

async function fetchIssueTimeline(repo, issue) {
  return collectPaginated(async (cursor) => {
    const data = await ghGraphql(ISSUE_TIMELINE_QUERY, {
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

async function fetchQueue(openIssues, repo) {
  const candidates = openIssues.items.filter((issue) => issueHasLabel(issue, 'loop-ready'));
  const referenceNumbers = [...new Set(
    candidates.flatMap((issue) => blockedByIssueNumbers(issue.body)),
  )];
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
      (issueNumber) => fetchDependencyIssue(repo, issueNumber),
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
    const section = await fetchIssueTimeline(repo, issue);
    const provenance = labelProvenance(section.items);
    const provenanceComplete =
      typeof provenance?.labeledBy === 'string'
      && provenance.labeledBy.length > 0
      && typeof provenance.labeledAt === 'string'
      && provenance.labeledAt.length > 0;
    const item = {
      ...issue,
      blockedBy,
      dependencies,
      provenance,
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
    const data = await ghGraphql(REVIEW_THREADS_QUERY, {
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

async function fetchThreadComments(thread) {
  let initial = true;
  return collectPaginated(async (cursor) => {
    if (initial) {
      initial = false;
      return connectionPage(thread.comments, `thread ${thread.id} comments`);
    }
    const data = await ghGraphql(THREAD_COMMENTS_QUERY, {
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
    const comments = await fetchThreadComments(thread);
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
    const data = await ghGraphql(query, {
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
    const data = await ghJson([
      'api',
      '--method',
      'GET',
      `repos/${repo.owner}/${repo.name}/collaborators/${encodeURIComponent(login)}/permission`,
    ]);
    const role = normalizeRoleResponse(data, login);
    if (!role) {
      throw new Error(`author permission response for ${login} is incomplete`);
    }
    return completeSection([role]);
  } catch (error) {
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

export async function repositorySnapshot({ now = () => new Date().toISOString() } = {}) {
  const scannedAt = now();
  const [repoSection, tree] = await Promise.all([
    fetchRepo(),
    Promise.resolve(fetchTree()),
  ]);
  if (!repoSection.complete) {
    const sections = dependencySections(repoSection.error.message);
    sections.repo = repoSection;
    sections.tree = tree;
    return createSnapshot({ scannedAt, sections });
  }
  const repo = repoSection.items[0];
  const [openPrs, openIssues, mergedPrs] = await Promise.all([
    fetchPullRequests(repo, ['OPEN']),
    fetchOpenIssues(repo),
    fetchPullRequests(repo, ['MERGED']),
  ]);
  const [queue, lifecycleMarkers] = await Promise.all([
    fetchQueue(openIssues, repo),
    fetchLifecycleMarkers(openPrs, openIssues, mergedPrs, repo),
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
  return createSnapshot({
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
  const checks = [
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
