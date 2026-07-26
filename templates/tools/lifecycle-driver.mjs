#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPremergeRecord,
  derivePremergeRecordObservation,
  parsePremergeRecordComment,
  premergeRecordHash,
  serializePremergeRecord,
} from './attestation-contract.mjs';
import { parseLoopClaim } from './claim-contract.mjs';
import { finalizeHead } from './delivery-contract.mjs';
import {
  advanceLifecycleRevision,
  beginLifecycleRevision,
  lifecycleCommentNeverEdited,
  lifecycleIdentityHash,
  parseLifecycleComment,
  reconcileLifecycle,
  resolveLifecycleCommentChain,
  serializeLifecycleMarker,
  serializeLifecycleSuccessor,
} from './lifecycle-contract.mjs';
import {
  appendPremergeTerminalOutcome,
  createPremergeRecordComment,
  policyAttestationForRecord,
} from './publish-verdict.mjs';
import { snapshotExecutionRepository } from './checkout-contract.mjs';

const SHA_RE = /^[0-9a-f]{40}$/u;
const HASH_RE = /^[0-9a-f]{64}$/u;
const BRANCH_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,254})$/u;
const COMMENT_ID_RE = /^[A-Za-z0-9_-]{1,255}$/u;
const MAX_PAGES = 100;
const MAX_STEPS = 24;
const BLOCKING_LABELS = new Set([
  'automerge:halt',
  'do-not-merge',
  'human:authorize',
  'human:legal',
  'loop-blocked',
  'needs-dependency',
  'needs-human',
  'needs-secret',
]);

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function exactKeys(value, keys) {
  return (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
  );
}

function sanitizedEnvironment() {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        !key.startsWith('GIT_')
        && !['GH_HOST', 'GH_REPO', 'GITHUB_REPOSITORY'].includes(key)),
    ),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function command(executable, args, options = {}) {
  return execFileSync(executable, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    input: options.input,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: options.timeout ?? 30000,
    maxBuffer: 64 * 1024 * 1024,
    env: sanitizedEnvironment(),
  }).trim();
}

function commandResult(executable, args, options = {}) {
  return spawnSync(executable, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    input: options.input,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: options.timeout ?? 30000,
    maxBuffer: 64 * 1024 * 1024,
    env: sanitizedEnvironment(),
  });
}

function repositoryTarget(root) {
  const { repository } = snapshotExecutionRepository(root);
  const { host, owner, repo } = repository;
  if (
    !/^[A-Za-z0-9_.-]{1,100}$/u.test(owner ?? '')
    || !/^[A-Za-z0-9_.-]{1,100}$/u.test(repo ?? '')
    || !/^[A-Za-z0-9.-]{1,253}$/u.test(host ?? '')
  ) {
    throw new Error('repository identity is invalid');
  }
  return { host, owner, repo };
}

function parseOrigin(value) {
  let host;
  let path;
  const scp = value.match(/^git@([A-Za-z0-9.-]+):(.+)$/u);
  if (scp) {
    [, host, path] = scp;
  } else {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      return null;
    }
    if (
      !['https:', 'ssh:'].includes(parsed.protocol)
      || parsed.search !== ''
      || parsed.hash !== ''
      || parsed.port !== ''
      || parsed.password !== ''
      || (
        parsed.protocol === 'https:'
        && parsed.username !== ''
      )
      || (
        parsed.protocol === 'ssh:'
        && !['', 'git'].includes(parsed.username)
      )
    ) {
      return null;
    }
    host = parsed.hostname;
    path = parsed.pathname.replace(/^\/+/u, '');
  }
  const canonicalPath = path.endsWith('.git') ? path.slice(0, -4) : path;
  const match = canonicalPath.match(
    /^([A-Za-z0-9](?:[A-Za-z0-9._-]{0,99}))\/([A-Za-z0-9](?:[A-Za-z0-9._-]{0,99}))$/u,
  );
  return match
    ? {
      host: host.toLowerCase(),
      owner: match[1].toLowerCase(),
      repo: match[2].toLowerCase(),
    }
    : null;
}

function exactOrigin(root, repository) {
  const values = command(
    'git',
    ['config', '--get-all', 'remote.origin.url'],
    { cwd: root },
  ).split(/\r?\n/u).filter(Boolean);
  if (
    values.length !== 1
    || stableJson(parseOrigin(values[0])) !== stableJson(repository)
  ) {
    throw new Error('origin no longer matches the lifecycle repository');
  }
  return values[0];
}

function apiArgs(repository, endpoint, method = 'GET') {
  return [
    'api',
    '--hostname',
    repository.host,
    endpoint,
    '-H',
    'Accept: application/vnd.github+json',
    '-H',
    'X-GitHub-Api-Version: 2026-03-10',
    ...(method === 'GET' ? [] : ['--method', method, '--input', '-']),
  ];
}

function api(repository, endpoint) {
  return JSON.parse(command('gh', apiArgs(repository, endpoint)));
}

function apiOptional(repository, endpoint) {
  const result = commandResult('gh', apiArgs(repository, endpoint));
  if (result.status === 0 && !result.error) return JSON.parse(result.stdout);
  if (String(result.stderr).includes('HTTP 404')) return null;
  throw new Error(
    result.error?.message
    ?? String(result.stderr).trim()
    ?? `GitHub API failed with status ${result.status}`,
  );
}

function mutate(repository, endpoint, method, input) {
  return JSON.parse(command(
    'gh',
    apiArgs(repository, endpoint, method),
    { input: JSON.stringify(input) },
  ));
}

function paginated(repository, endpoint) {
  const items = [];
  const ids = new Set();
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const separator = endpoint.includes('?') ? '&' : '?';
    const values = api(
      repository,
      `${endpoint}${separator}per_page=100&page=${page}`,
    );
    if (!Array.isArray(values)) throw new Error('paginated GitHub response is invalid');
    for (const value of values) {
      const id = value?.node_id ?? value?.id;
      if (id === null || id === undefined || ids.has(String(id))) {
        throw new Error('paginated GitHub response is duplicated or unidentifiable');
      }
      ids.add(String(id));
      items.push(value);
    }
    if (values.length < 100) return items;
  }
  throw new Error('paginated GitHub response exceeds the lifecycle bound');
}

function permission(repository, login) {
  const value = api(
    repository,
    `repos/${repository.owner}/${repository.repo}/collaborators/`
    + `${encodeURIComponent(login)}/permission`,
  );
  return value?.role_name ?? null;
}

function authorizedRole(role, author, viewer) {
  return ['admin', 'maintain'].includes(role)
    || (author === viewer && role === 'write');
}

function lifecycleChainInput(comment) {
  return {
    id: comment.id,
    body: comment.body,
    neverEdited: comment.neverEdited === true,
  };
}

function commentValue(comment) {
  return {
    id: String(comment.node_id),
    restId: comment.id,
    author: comment.user?.login ?? null,
    body: comment.body ?? '',
    // REST exposes no `lastEditedAt`; timestamp identity is its only
    // never-edited proof, so absent timestamps stay edited.
    neverEdited: lifecycleCommentNeverEdited({
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
    }),
  };
}

function findClaimCommit(root, branch, issue) {
  const branchResult = commandResult(
    'git',
    ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`],
    { cwd: root },
  );
  if (branchResult.status !== 0) {
    return { complete: true, exists: false };
  }
  const headOid = branchResult.stdout.trim().toLowerCase();
  const lines = command(
    'git',
    [
      'log',
      '--format=%H%x09%s',
      `refs/heads/${branch}`,
      '--fixed-strings',
      `--grep=chore: claim #${issue}`,
    ],
    { cwd: root },
  ).split(/\r?\n/u).filter(Boolean);
  const matches = lines
    .map((line) => {
      const [oid, ...subjectParts] = line.split('\t');
      return { oid: oid?.toLowerCase(), subject: subjectParts.join('\t') };
    })
    .filter((entry) =>
      entry.subject === `chore: claim #${issue}` && SHA_RE.test(entry.oid ?? ''));
  if (matches.length > 1) {
    throw new Error('local claim commit is ambiguous');
  }
  if (matches.length === 0) {
    return {
      complete: true,
      exists: false,
      branch,
      preparedHeadOid: headOid,
    };
  }
  return {
    complete: true,
    exists: true,
    branch,
    claimCommit: matches[0].oid,
    headOid,
  };
}

function remoteClaim(repository, branch, claimCommit) {
  const value = apiOptional(
    repository,
    `repos/${repository.owner}/${repository.repo}/git/ref/heads/${branch}`,
  );
  if (value === null) return { complete: true, exists: false };
  const headOid = value?.object?.sha?.toLowerCase();
  if (!SHA_RE.test(headOid ?? '')) {
    throw new Error('remote claim ref is invalid');
  }
  if (!SHA_RE.test(claimCommit ?? '')) {
    return {
      complete: true,
      exists: true,
      branch,
      headOid,
      containsClaimCommit: null,
    };
  }
  const comparison = api(
    repository,
    `repos/${repository.owner}/${repository.repo}/compare/`
    + `${claimCommit}...${headOid}`,
  );
  return {
    complete: true,
    exists: true,
    branch,
    headOid,
    containsClaimCommit: ['ahead', 'identical'].includes(comparison?.status),
  };
}

function exactPullRequest(pullRequests, branch, issue) {
  const matches = pullRequests.filter((pullRequest) => {
    const claim = parseLoopClaim({
      branch: pullRequest?.head?.ref,
      body: pullRequest?.body ?? '',
    });
    return pullRequest?.head?.ref === branch
      && claim.valid
      && claim.issue === issue;
  });
  if (matches.length > 1) throw new Error('loop pull request is ambiguous');
  return matches[0] ?? null;
}

function premergeFacts(comments, marker, draft) {
  const commentItems = comments.map((comment) => ({
    id: comment.id,
    author: { login: comment.author },
    body: comment.body,
  }));
  let record = draft;
  let expectedComment = null;
  if (marker?.premergeRecord) {
    expectedComment = comments.find((comment) => {
      const parsed = parsePremergeRecordComment(comment.body);
      return parsed.ok
        && parsed.record.recordId === marker.premergeRecord
        && parsed.premergeBodyHash === marker.premergeRecordHash;
    }) ?? null;
    if (expectedComment) record = parsePremergeRecordComment(expectedComment.body).record;
  } else if (!record && SHA_RE.test(marker?.headOid ?? '')) {
    const candidates = comments.filter((comment) => {
      const parsed = parsePremergeRecordComment(comment.body);
      return parsed.ok
        && parsed.record.issue === marker.issue
        && parsed.record.pullRequest === marker.pr
        && parsed.record.headOid === marker.headOid;
    });
    if (candidates.length > 1) throw new Error('premerge record is ambiguous');
    expectedComment = candidates[0] ?? null;
    if (expectedComment) record = parsePremergeRecordComment(expectedComment.body).record;
  }
  if (!record) {
    return {
      record: null,
      author: null,
      premergeRecord: { complete: true, exists: false },
      finalRecord: { complete: true, exists: false },
    };
  }
  serializePremergeRecord(record);
  const bodyHash = premergeRecordHash(record);
  const author = expectedComment?.author
    ?? comments.find((comment) => {
      const parsed = parsePremergeRecordComment(comment.body);
      return parsed.ok && parsed.record.recordId === record.recordId;
    })?.author
    ?? null;
  if (author === null) {
    return {
      record,
      author: null,
      premergeRecord: { complete: true, exists: false },
      finalRecord: { complete: true, exists: false },
    };
  }
  const observation = derivePremergeRecordObservation(
    { complete: true, items: commentItems },
    {
      issue: record.issue,
      headOid: record.headOid,
      recordId: record.recordId,
      bodyHash,
      author,
    },
  );
  return {
    record,
    author,
    premergeRecord: observation,
    finalRecord: {
      complete: observation.complete,
      exists: observation.outcome !== null,
      verified: observation.verified && observation.outcome !== null,
      premergeRecord: observation.id,
      premergeRecordHash: observation.bodyHash,
      commentId: observation.commentId,
      headOid: observation.outcome?.headOid ?? observation.headOid,
      mergeOid: observation.outcome?.mergeOid ?? null,
    },
  };
}

function readOperationalState(request, root) {
  const repository = repositoryTarget(root);
  const issue = api(
    repository,
    `repos/${repository.owner}/${repository.repo}/issues/${request.intent.issue}`,
  );
  if (
    issue?.number !== request.intent.issue
    || sha256(issue.body ?? '') !== request.intent.issueBodyHash
  ) {
    throw new Error('live issue does not match the lifecycle intent');
  }
  const viewer = api(repository, 'user')?.login;
  if (typeof viewer !== 'string' || viewer.length === 0) {
    throw new Error('authenticated GitHub viewer is unavailable');
  }
  const rawComments = paginated(
    repository,
    `repos/${repository.owner}/${repository.repo}/issues/${request.intent.issue}/comments`,
  );
  const comments = rawComments.map(commentValue);
  const markerCandidates = comments
    .filter((comment) => comment.body.includes('<!-- autoloop-lifecycle-v'))
    .map((comment) => ({
      comment,
      role: permission(repository, comment.author),
    }));
  const malformedAuthoritative = markerCandidates.some(
    ({ comment, role }) =>
      authorizedRole(role, comment.author, viewer)
      && (() => {
        const parsed = parseLifecycleComment(comment.body);
        return !parsed.ok || parsed.marker.issue !== request.intent.issue;
      })(),
  );
  if (malformedAuthoritative) {
    throw new Error('authoritative lifecycle marker is malformed or mismatched');
  }
  const authorizedMarkerCandidates = markerCandidates.filter(
    ({ comment, role }) => authorizedRole(role, comment.author, viewer),
  );
  let markerChain = resolveLifecycleCommentChain(
    authorizedMarkerCandidates.map(({ comment }) => lifecycleChainInput(comment)),
    request.lifecycleCommentId,
  );
  if (markerChain !== null) {
    const rootAuthor = authorizedMarkerCandidates.find(
      ({ comment }) => comment.id === markerChain.root.id,
    )?.comment.author;
    if (
      typeof rootAuthor !== 'string'
      || authorizedMarkerCandidates.some(({ comment }) => {
        const parsed = parseLifecycleComment(comment.body);
        return (
          parsed.successor === null
          || parsed.successor?.rootCommentId === markerChain.root.id
        ) && comment.author !== rootAuthor;
      })
    ) {
      throw new Error('lifecycle chain author changed');
    }
    markerChain = resolveLifecycleCommentChain(
      authorizedMarkerCandidates
        .filter(({ comment }) => comment.author === rootAuthor)
        .map(({ comment }) => lifecycleChainInput(comment)),
      request.lifecycleCommentId,
    );
  }
  const markerRootEntry = markerChain === null
    ? null
    : comments.find((comment) => comment.id === markerChain.root.id) ?? null;
  const markerEntry = markerChain === null
    ? null
    : comments.find((comment) => comment.id === markerChain.tip.id) ?? null;
  if (markerChain !== null && (!markerRootEntry || !markerEntry)) {
    throw new Error('lifecycle comment chain readback is incomplete');
  }
  const marker = markerChain?.tip.marker ?? null;
  const localClaim = findClaimCommit(
    root,
    request.intent.branch,
    request.intent.issue,
  );
  const remote = remoteClaim(
    repository,
    request.intent.branch,
    marker?.claimCommit ?? localClaim.claimCommit,
  );
  const planCandidates = comments.filter((comment) =>
    sha256(comment.body) === request.intent.planHash
    && authorizedRole(permission(repository, comment.author), comment.author, viewer));
  if (planCandidates.length > 1) throw new Error('frozen plan comment is ambiguous');
  const planComment = planCandidates[0] ?? null;
  const pullRequests = paginated(
    repository,
    `repos/${repository.owner}/${repository.repo}/pulls?state=all`,
  );
  const pullRequest = exactPullRequest(
    pullRequests,
    request.intent.branch,
    request.intent.issue,
  );
  const merged = typeof pullRequest?.merged_at === 'string'
    && pullRequest.merged_at.length > 0;
  if (issue.state !== 'open' && !merged) {
    throw new Error('unmerged lifecycle issue is not open');
  }
  const labels = (issue.labels ?? [])
    .map((label) => label?.name)
    .filter((label) => typeof label === 'string');
  let delivery = { complete: true, exists: false };
  if (pullRequest && !merged) {
    const headOid = pullRequest.head?.sha?.toLowerCase();
    const deliveryRequest = {
      schemaVersion: 1,
      repository: `${repository.owner}/${repository.repo}`,
      pullRequest: pullRequest.number,
      committedHead: headOid,
      reviewedHead: headOid,
      gatedHead: headOid,
    };
    delivery = {
      complete: true,
      exists: labels.includes('loop-delivered'),
      ...(labels.includes('loop-delivered') ? { headOid } : {}),
      request: deliveryRequest,
    };
  }
  const premerge = premergeFacts(
    comments,
    marker,
    request.premergeRecordDraft,
  );
  const observed = {
    localClaim,
    remoteClaim: remote,
    planComment: {
      complete: true,
      exists: planComment !== null,
      ...(planComment
        ? { planHash: request.intent.planHash, id: planComment.id }
        : {}),
    },
    draftPr: {
      complete: true,
      exists: pullRequest !== null,
      ...(pullRequest
        ? {
          number: pullRequest.number,
          issue: request.intent.issue,
          branch: pullRequest.head.ref,
        }
        : {}),
    },
    delivery,
    premergeRecord: premerge.premergeRecord,
    merge: {
      complete: pullRequest !== null,
      merged,
      ...(merged
        ? {
          headOid: pullRequest.head.sha.toLowerCase(),
          mergeOid: pullRequest.merge_commit_sha?.toLowerCase(),
        }
        : {}),
    },
    finalRecord: premerge.finalRecord,
  };
  return {
    repository,
    viewer,
    viewerRole: permission(repository, viewer),
    issue: {
      number: issue.number,
      labels,
      nodeId: issue.node_id,
    },
    comments,
    marker,
    markerComment: markerEntry,
    lifecycleRootCommentId: markerRootEntry?.id ?? null,
    lifecycleSequence: markerChain?.sequence ?? null,
    observed,
    premergeRecordDraft: premerge.record ?? request.premergeRecordDraft,
    premergeAuthor: premerge.author,
    pullRequest,
  };
}

function validateIntent(intent) {
  const result = reconcileLifecycle({ intent, marker: null });
  return result.action === 'persist-intent';
}

function validateReconcileRequest(request) {
  return (
    exactKeys(request, [
      'baseBranch',
      'intent',
      'lifecycleCommentId',
      'plan',
      'premergeRecordDraft',
      'schemaVersion',
    ])
    && request.schemaVersion === 1
    // The policy set is the lifecycle contract's to define (it validates
    // 'manual', 'ratified', and 'auto' at lifecycle-contract.mjs:81, and
    // branches on the distinction where it matters). This extra 'manual'-only
    // clause was a leftover from when non-manual was dormant reference code,
    // and it refused the claim step for every acknowledged non-manual repo.
    && validateIntent(request.intent)
    && BRANCH_RE.test(request.baseBranch ?? '')
    && (
      request.lifecycleCommentId === null
      || COMMENT_ID_RE.test(request.lifecycleCommentId ?? '')
    )
    && exactKeys(request.plan, ['body', 'prBody', 'title'])
    && typeof request.plan.body === 'string'
    && request.plan.body.length > 0
    && request.plan.body.length <= 65535
    && sha256(request.plan.body) === request.intent.planHash
    && typeof request.plan.title === 'string'
    && /^[\x20-\x7e]{1,256}$/u.test(request.plan.title)
    && typeof request.plan.prBody === 'string'
    && request.plan.prBody.length > 0
    && request.plan.prBody.length <= 65535
    && parseLoopClaim({
      branch: request.intent.branch,
      body: request.plan.prBody,
    }).issue === request.intent.issue
    && (
      request.premergeRecordDraft === null
      || (() => {
        try {
          serializePremergeRecord(request.premergeRecordDraft);
          return true;
        } catch {
          return false;
        }
      })()
    )
  );
}

function postIssueComment(state, body) {
  const response = mutate(
    state.repository,
    `repos/${state.repository.owner}/${state.repository.repo}/issues/`
    + `${state.issue.number}/comments`,
    'POST',
    { body },
  );
  if (
    typeof response?.node_id !== 'string'
    || response.body !== body
    || response.user?.login !== state.viewer
  ) {
    throw new Error('issue comment mutation postcondition is invalid');
  }
  return response.node_id;
}

function appendLifecycleSuccessor(state, marker) {
  if (
    !state.markerComment
    || !COMMENT_ID_RE.test(state.lifecycleRootCommentId ?? '')
    || !Number.isSafeInteger(state.lifecycleSequence)
    || state.lifecycleSequence < 0
  ) {
    throw new Error('lifecycle successor predecessor is unavailable');
  }
  return postIssueComment(
    state,
    serializeLifecycleSuccessor(marker, {
      v: 1,
      rootCommentId: state.lifecycleRootCommentId,
      previousCommentId: state.markerComment.id,
      previousBodyHash: sha256(state.markerComment.body),
      sequence: state.lifecycleSequence + 1,
    }),
  );
}

function replaceLabels(state, labels) {
  const response = mutate(
    state.repository,
    `repos/${state.repository.owner}/${state.repository.repo}/issues/`
    + `${state.issue.number}/labels`,
    'PUT',
    { labels },
  );
  const returned = Array.isArray(response)
    ? response.map((label) => label?.name).filter(Boolean).sort()
    : [];
  if (returned.join('\0') !== [...labels].sort().join('\0')) {
    throw new Error('issue label mutation postcondition is invalid');
  }
}

function ensureLocalClaimGit(root, request) {
  const status = command(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    { cwd: root },
  );
  const baseOid = command(
    'git',
    ['rev-parse', '--verify', `${request.baseBranch}^{commit}`],
    { cwd: root },
  ).toLowerCase();
  if (status !== '' || baseOid !== request.intent.plannedBaseOid) {
    throw new Error('local claim requires a clean exact planned base');
  }
  const branchRef = `refs/heads/${request.intent.branch}`;
  const existing = commandResult(
    'git',
    ['rev-parse', '--verify', `${branchRef}^{commit}`],
    { cwd: root },
  );
  if (existing.status === 0) {
    if (existing.stdout.trim().toLowerCase() !== request.intent.plannedBaseOid) {
      throw new Error('partial local claim branch moved from its planned base');
    }
    command(
      'git',
      ['-c', 'core.hooksPath=/dev/null', 'switch', request.intent.branch],
      { cwd: root },
    );
  } else {
    command(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        'switch',
        '-c',
        request.intent.branch,
        request.intent.plannedBaseOid,
      ],
      { cwd: root },
    );
  }
  command(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '--no-verify',
      '-m',
      `chore: claim #${request.intent.issue}`,
    ],
    { cwd: root },
  );
}

function productionAdapters(root) {
  return {
    read: (request) => readOperationalState(request, root),
    persistIntent: (state, marker) =>
      postIssueComment(state, serializeLifecycleMarker(marker)),
    updateMarker: (state, marker) =>
      appendLifecycleSuccessor(state, marker),
    ensureLocalClaim: (state, request) => {
      const labels = state.issue.labels.filter((label) => !label.startsWith('loop:'));
      if (!labels.includes('loop-started')) labels.push('loop-started');
      labels.push('loop:04-claim');
      replaceLabels(state, [...new Set(labels)]);
      ensureLocalClaimGit(root, request);
    },
    ensureRemoteClaim: (state, request) => {
      const current = repositoryTarget(root);
      if (stableJson(current) !== stableJson(state.repository)) {
        throw new Error('repository identity changed before claim push');
      }
      const origin = exactOrigin(root, current);
      command(
        'git',
        [
          '-c',
          'core.hooksPath=/dev/null',
          'push',
          '--no-verify',
          origin,
          `HEAD:refs/heads/${request.intent.branch}`,
        ],
        { cwd: root, timeout: 120000 },
      );
    },
    ensurePlanComment: (state, request) =>
      postIssueComment(state, request.plan.body),
    ensureDraftPr: (state, request) => {
      const baseRef = api(
        state.repository,
        `repos/${state.repository.owner}/${state.repository.repo}/git/ref/heads/`
        + `${request.baseBranch}`,
      );
      if (baseRef?.object?.sha?.toLowerCase() !== request.intent.plannedBaseOid) {
        throw new Error('configured base moved before draft creation');
      }
      const response = mutate(
        state.repository,
        `repos/${state.repository.owner}/${state.repository.repo}/pulls`,
        'POST',
        {
          title: request.plan.title,
          head: request.intent.branch,
          base: request.baseBranch,
          body: request.plan.prBody,
          draft: true,
        },
      );
      if (
        !Number.isSafeInteger(response?.number)
        || response.head?.ref !== request.intent.branch
        || response.base?.ref !== request.baseBranch
        || response.draft !== true
      ) {
        throw new Error('draft pull request mutation postcondition is invalid');
      }
    },
    createPremerge: (state, record) =>
      createPremergeRecordComment(record, state.repository, {
        repositoryRoot: root,
      }),
    restoreDelivered: (state) => {
      const labels = state.issue.labels.filter(
        (label) => label !== 'loop-started' && !label.startsWith('loop:'),
      );
      if (!labels.includes('loop-delivered')) labels.push('loop-delivered');
      replaceLabels(state, [...new Set(labels)]);
    },
    appendOutcome: (state, result) => {
      if (!state.premergeRecordDraft || !state.premergeAuthor) {
        throw new Error('verified premerge record is unavailable');
      }
      const attestation = policyAttestationForRecord(
        state.premergeRecordDraft,
        state.premergeAuthor,
      );
      if (
        attestation.premergeRecordId !== result.premergeRecord
        || attestation.premergeRecordHash !== result.premergeRecordHash
      ) {
        throw new Error('terminal outcome action changed premerge identity');
      }
      appendPremergeTerminalOutcome(
        attestation,
        result.mergeOid,
        state.repository,
        { expectedCommentBodyHash: result.expectedCommentBodyHash },
      );
    },
    ensureRevisionLabels: (state) => {
      const labels = state.issue.labels.filter(
        (label) =>
          label !== 'loop-delivered'
          && label !== 'loop-started'
          && !label.startsWith('loop:'),
      );
      labels.push('loop:revising');
      replaceLabels(state, [...new Set(labels)]);
    },
  };
}

function readStable(adapters, request) {
  const first = adapters.read(request);
  const second = adapters.read(request);
  if (stableJson(first) !== stableJson(second)) {
    throw new Error('lifecycle evidence changed during stable observation');
  }
  return second;
}

function markerAfter(state, result) {
  if (result.marker) return result.marker;
  if (result.markerPatch) return { ...state.marker, ...result.markerPatch };
  return null;
}

function applyLifecycleAction(adapters, state, request, result) {
  const marker = markerAfter(state, result);
  if (result.action === 'persist-intent') {
    return adapters.persistIntent(state, result.marker);
  }
  if (marker) {
    adapters.updateMarker(state, marker);
    return request.lifecycleCommentId;
  }
  if (result.action === 'ensure-local-claim') {
    adapters.ensureLocalClaim(state, request);
  } else if (result.action === 'ensure-remote-claim') {
    adapters.ensureRemoteClaim(state, request);
  } else if (result.action === 'ensure-plan-comment') {
    adapters.ensurePlanComment(state, request);
  } else if (result.action === 'ensure-draft-pr') {
    adapters.ensureDraftPr(state, request);
  } else if (result.action === 'write-premerge-record') {
    adapters.createPremerge(state, result.record);
  } else if (result.action === 'restore-delivered') {
    adapters.restoreDelivered(state);
  } else if (result.action === 'append-merge-outcome') {
    adapters.appendOutcome(state, result);
  } else {
    throw new Error(`unsupported lifecycle effect: ${result.action}`);
  }
  return request.lifecycleCommentId;
}

export function driveLifecycle(request, context = {}) {
  if (!validateReconcileRequest(request)) {
    throw new Error('lifecycle reconcile request is invalid');
  }
  const adapters = context.adapters ?? productionAdapters(
    context.repositoryRoot ?? process.cwd(),
  );
  let current = structuredClone(request);
  for (let step = 0; step < MAX_STEPS; step += 1) {
    const state = readStable(adapters, current);
    const result = reconcileLifecycle({
      intent: current.intent,
      marker: state.marker,
      observed: state.observed,
      ...(state.premergeRecordDraft
        ? { premergeRecordDraft: state.premergeRecordDraft }
        : {}),
    }, {
      repositoryRoot: context.repositoryRoot ?? process.cwd(),
    });
    if (['complete', 'block', 'wait', 'resume'].includes(result.state)) {
      if (result.markerPatch) {
        const nextMarker = markerAfter(state, result);
        if (stableJson(nextMarker) !== stableJson(state.marker)) {
          adapters.updateMarker(state, nextMarker);
          continue;
        }
      }
      return {
        schemaVersion: 1,
        state: result.state,
        action: result.action,
        code: result.code,
        lifecycleCommentId: current.lifecycleCommentId,
        marker: state.marker,
      };
    }
    if (result.state !== 'act') {
      throw new Error(`unknown lifecycle transition state: ${result.state}`);
    }
    const lifecycleCommentId = applyLifecycleAction(
      adapters,
      state,
      current,
      result,
    );
    if (current.lifecycleCommentId === null) {
      current = { ...current, lifecycleCommentId };
    }
    if (result.action === 'bind-ready-head') {
      const readback = readStable(adapters, current);
      if (
        readback.marker?.phase !== 'ready-head'
        || readback.marker.headOid !== result.markerPatch?.headOid
      ) {
        throw new Error('ready-head lifecycle postcondition is unverified');
      }
      return {
        schemaVersion: 1,
        state: 'complete',
        action: 'bind-ready-head',
        code: 'READY_HEAD_BOUND',
        lifecycleCommentId: current.lifecycleCommentId,
        marker: readback.marker,
      };
    }
  }
  throw new Error('lifecycle reconciliation exceeded its bounded step count');
}

function validateRevisionDriverRequest(request) {
  return (
    exactKeys(request, [
      'lifecycleCommentId',
      'revision',
      'schemaVersion',
    ])
    && request.schemaVersion === 1
    && COMMENT_ID_RE.test(request.lifecycleCommentId ?? '')
    && request.revision !== null
    && typeof request.revision === 'object'
    && !Array.isArray(request.revision)
  );
}

function revisionObserved(state, request) {
  const planComment = state.comments.find(
    (comment) => comment.id === request.revision.planCommentId,
  );
  return {
    complete: (
      state.pullRequest !== null
      && planComment !== undefined
      && sha256(planComment.body) === request.revision.planHash
      && planComment.author === state.viewer
      && ['write', 'maintain', 'admin'].includes(state.viewerRole)
    ),
    headOid: state.pullRequest?.head?.sha?.toLowerCase() ?? null,
    labels: [...state.issue.labels],
    planComment: {
      complete: planComment !== undefined,
      id: planComment?.id ?? null,
      bodyHash: planComment ? sha256(planComment.body) : null,
    },
  };
}

export function driveLifecycleRevision(request, context = {}) {
  if (!validateRevisionDriverRequest(request)) {
    throw new Error('lifecycle revision request is invalid');
  }
  const adapters = context.adapters ?? productionAdapters(
    context.repositoryRoot ?? process.cwd(),
  );
  const readRequest = context.readRequest ?? {
    schemaVersion: 1,
    intent: context.intent,
    baseBranch: context.baseBranch,
    lifecycleCommentId: request.lifecycleCommentId,
    plan: context.plan,
    premergeRecordDraft: null,
  };
  for (let step = 0; step < 6; step += 1) {
    const state = readStable(adapters, readRequest);
    if (
      !state.marker
      || state.lifecycleRootCommentId !== request.lifecycleCommentId
      || !['write', 'maintain', 'admin'].includes(state.viewerRole)
      || state.issue.labels.some((label) => BLOCKING_LABELS.has(label))
    ) {
      throw new Error('authenticated Pitcrew revision authority is unavailable');
    }
    const begun = beginLifecycleRevision(state.marker, request.revision);
    if (begun.state === 'complete') {
      return {
        schemaVersion: 1,
        state: 'complete',
        code: begun.code,
        epoch: begun.epoch,
        lifecycleCommentId: request.lifecycleCommentId,
      };
    }
    if (begun.state === 'block') {
      return {
        schemaVersion: 1,
        state: 'block',
        action: begun.action,
        code: begun.code,
        lifecycleCommentId: request.lifecycleCommentId,
      };
    }
    const prerequisites = revisionObserved(state, request);
    if (!prerequisites.complete) {
      return {
        schemaVersion: 1,
        state: 'wait',
        action: 'inspect-revision-prerequisites',
        code: 'EVIDENCE_INCOMPLETE',
        lifecycleCommentId: request.lifecycleCommentId,
      };
    }
    if (prerequisites.headOid !== request.revision.expectedHeadOid) {
      return {
        schemaVersion: 1,
        state: 'block',
        action: 'revision-race',
        code: 'REVISION_PREREQUISITE_MISMATCH',
        lifecycleCommentId: request.lifecycleCommentId,
      };
    }
    if (begun.state === 'act') {
      adapters.updateMarker(state, begun.marker);
      continue;
    }
    if (
      !prerequisites.labels.includes('loop:revising')
      || prerequisites.labels.includes('loop-delivered')
    ) {
      adapters.ensureRevisionLabels(state);
      continue;
    }
    const advanced = advanceLifecycleRevision(state.marker, prerequisites);
    if (advanced.state === 'block') {
      return {
        schemaVersion: 1,
        state: 'block',
        action: advanced.action,
        code: advanced.code,
        lifecycleCommentId: request.lifecycleCommentId,
      };
    }
    if (advanced.state !== 'act') {
      return {
        schemaVersion: 1,
        state: 'wait',
        action: advanced.action,
        code: advanced.code,
        lifecycleCommentId: request.lifecycleCommentId,
      };
    }
    adapters.updateMarker(state, advanced.marker);
  }
  throw new Error('lifecycle revision exceeded its bounded step count');
}

function fakeIntent() {
  return {
    issue: 7,
    issueBodyHash: 'b'.repeat(64),
    planHash: 'c'.repeat(64),
    branch: 'feat/gh-7-contract',
    plannedBaseOid: 'a'.repeat(40),
    selector: 'native',
    runIntentHash: 'd'.repeat(64),
    intentSource: 'invocation',
    mergePolicy: 'manual',
  };
}

function fakeReconcileRequest() {
  return {
    schemaVersion: 1,
    intent: fakeIntent(),
    baseBranch: 'main',
    lifecycleCommentId: null,
    plan: {
      body: 'frozen plan',
      title: 'Lifecycle fixture',
      prBody: 'Closes #7',
    },
    premergeRecordDraft: null,
  };
}

function selfTest() {
  const request = fakeReconcileRequest();
  request.intent.planHash = sha256(request.plan.body);
  const effects = [];
  let marker = null;
  const reconcileAdapters = {
    read: () => ({
      marker: structuredClone(marker),
      markerComment: marker
        ? { id: 'IC_lifecycle', restId: 1, body: serializeLifecycleMarker(marker) }
        : null,
      observed: {
        localClaim: { complete: true, exists: true, branch: request.intent.branch, claimCommit: '1'.repeat(40) },
        remoteClaim: { complete: true, exists: true, branch: request.intent.branch, headOid: '1'.repeat(40), containsClaimCommit: true },
        planComment: { complete: true, exists: true, planHash: request.intent.planHash, id: 'IC_plan' },
        draftPr: { complete: true, exists: true, number: 12, issue: 7, branch: request.intent.branch },
        delivery: { complete: true, exists: false },
        premergeRecord: { complete: true, exists: false },
        merge: { complete: true, merged: false },
        finalRecord: { complete: true, exists: false },
      },
      premergeRecordDraft: null,
    }),
    persistIntent: (_state, value) => {
      effects.push('persist');
      marker = value;
      return 'IC_lifecycle';
    },
    updateMarker: (_state, value) => {
      effects.push(`marker:${value.phase}`);
      marker = value;
    },
  };
  const recovered = driveLifecycle(request, { adapters: reconcileAdapters });
  const delivered = {
    v: 1,
    ...fakeIntent(),
    epoch: 1,
    phase: 'premerge-record',
    claimCommit: '1'.repeat(40),
    pr: 12,
    planCommentId: 'IC_plan',
    headOid: '2'.repeat(40),
  };
  const recordId = `pmr_${'3'.repeat(64)}`;
  delivered.premergeRecord = recordId;
  delivered.premergeRecordHash = '4'.repeat(64);
  delivered.premergeRecordCommentId = 'IC_premerge';
  const revision = {
    expectedEpoch: 1,
    expectedHeadOid: delivered.headOid,
    expectedIdentityHash: lifecycleIdentityHash(delivered),
    expectedPlanCommentId: delivered.planCommentId,
    expectedPremergeRecord: delivered.premergeRecord,
    expectedPremergeRecordCommentId: delivered.premergeRecordCommentId,
    expectedPremergeRecordHash: delivered.premergeRecordHash,
    planCommentId: 'IC_plan_2',
    planHash: '5'.repeat(64),
    plannedBaseOid: '6'.repeat(40),
    runIntentHash: '7'.repeat(64),
    selector: 'codex',
  };
  let revisionMarker = delivered;
  let labels = ['loop-ready', 'loop-delivered'];
  let markerWrites = 0;
  const revisionState = () => ({
    marker: structuredClone(revisionMarker),
    lifecycleRootCommentId: 'IC_lifecycle',
    markerComment: {
      id: 'IC_lifecycle',
      restId: 1,
      body: serializeLifecycleMarker(revisionMarker),
    },
    viewer: 'maintainer',
    viewerRole: 'maintain',
    issue: { number: 7, labels: [...labels] },
    comments: [{
      id: revision.planCommentId,
      author: 'maintainer',
      body: 'revision plan',
    }],
    pullRequest: { head: { sha: delivered.headOid } },
  });
  revision.planHash = sha256('revision plan');
  const revisionAdapters = {
    read: revisionState,
    updateMarker: (_state, value) => {
      markerWrites += 1;
      revisionMarker = value;
    },
    ensureRevisionLabels: () => {
      labels = ['loop-ready', 'loop:revising'];
    },
  };
  const revisionRequest = {
    schemaVersion: 1,
    lifecycleCommentId: 'IC_lifecycle',
    revision,
  };
  const revisionResult = driveLifecycleRevision(revisionRequest, {
    adapters: revisionAdapters,
    readRequest: {},
  });
  const revisionReplay = driveLifecycleRevision(revisionRequest, {
    adapters: revisionAdapters,
    readRequest: {},
  });
  const raceMarker = delivered;
  const raceAdapters = {
    ...revisionAdapters,
    read: () => ({
      ...revisionState(),
      marker: structuredClone(raceMarker),
      markerComment: {
        id: 'IC_lifecycle',
        restId: 1,
        body: serializeLifecycleMarker(raceMarker),
      },
      pullRequest: { head: { sha: '9'.repeat(40) } },
      issue: { number: 7, labels: ['loop-ready', 'loop:revising'] },
    }),
    updateMarker: () => {
      throw new Error('race must not mutate');
    },
  };
  const race = driveLifecycleRevision(revisionRequest, {
    adapters: raceAdapters,
    readRequest: {},
  });
  const mergedIntent = fakeIntent();
  mergedIntent.planHash = sha256('merged frozen plan');
  const mergedMarkerBase = {
    v: 1,
    ...mergedIntent,
    epoch: 1,
    phase: 'premerge-record',
    claimCommit: '1'.repeat(40),
    pr: 12,
    planCommentId: 'IC_plan',
    headOid: '2'.repeat(40),
  };
  const mergedRecord = createPremergeRecord({
    issue: 7,
    pullRequest: 12,
    headOid: mergedMarkerBase.headOid,
    run: {
      intentHash: mergedMarkerBase.runIntentHash,
      receiptFingerprint: '8'.repeat(64),
    },
    plan: {
      commentId: mergedMarkerBase.planCommentId,
      contentHash: mergedMarkerBase.planHash,
    },
    review: { checkRunId: 101, summaryHash: '9'.repeat(64) },
    gate: { checkRunId: 102, summaryHash: 'a'.repeat(64) },
    ci: { policyHash: 'b'.repeat(64), evidenceHash: 'c'.repeat(64) },
    lifecycle: {
      commentId: 'IC_lifecycle',
      identityHash: lifecycleIdentityHash(mergedMarkerBase),
    },
  });
  let mergedMarker = {
    ...mergedMarkerBase,
    premergeRecord: mergedRecord.recordId,
    premergeRecordHash: premergeRecordHash(mergedRecord),
    premergeRecordCommentId: 'IC_premerge',
  };
  let finalRecord = { complete: true, exists: false };
  let terminalAppends = 0;
  const mergedRequest = {
    schemaVersion: 1,
    intent: mergedIntent,
    baseBranch: 'main',
    lifecycleCommentId: 'IC_lifecycle',
    plan: {
      body: 'merged frozen plan',
      title: 'Merged recovery',
      prBody: 'Closes #7',
    },
    premergeRecordDraft: mergedRecord,
  };
  const mergedObservation = {
    complete: true,
    exists: true,
    verified: true,
    id: mergedRecord.recordId,
    bodyHash: premergeRecordHash(mergedRecord),
    commentBodyHash: premergeRecordHash(mergedRecord),
    commentId: 'IC_premerge',
    issue: 7,
    pullRequest: 12,
    headOid: mergedRecord.headOid,
    record: mergedRecord,
  };
  const mergedAdapters = {
    read: () => ({
      marker: structuredClone(mergedMarker),
      markerComment: {
        id: 'IC_lifecycle',
        restId: 1,
        body: serializeLifecycleMarker(mergedMarker),
      },
      observed: {
        localClaim: {
          complete: true,
          exists: true,
          branch: mergedIntent.branch,
          claimCommit: mergedMarker.claimCommit,
        },
        remoteClaim: { complete: true, exists: false },
        planComment: {
          complete: true,
          exists: true,
          planHash: mergedIntent.planHash,
          id: mergedMarker.planCommentId,
        },
        draftPr: {
          complete: true,
          exists: true,
          number: 12,
          issue: 7,
          branch: mergedIntent.branch,
        },
        delivery: { complete: true, exists: false },
        premergeRecord: structuredClone(mergedObservation),
        merge: {
          complete: true,
          merged: true,
          headOid: mergedRecord.headOid,
          mergeOid: 'd'.repeat(40),
        },
        finalRecord: structuredClone(finalRecord),
      },
      premergeRecordDraft: mergedRecord,
    }),
    appendOutcome: () => {
      terminalAppends += 1;
      finalRecord = {
        complete: true,
        exists: true,
        verified: true,
        premergeRecord: mergedRecord.recordId,
        premergeRecordHash: premergeRecordHash(mergedRecord),
        commentId: 'IC_premerge',
        headOid: mergedRecord.headOid,
        mergeOid: 'd'.repeat(40),
      };
    },
    updateMarker: (_state, value) => {
      mergedMarker = value;
    },
  };
  const mergedRecovery = driveLifecycle(mergedRequest, {
    adapters: mergedAdapters,
  });
  const originalOverrides = {
    GIT_DIR: process.env.GIT_DIR,
    GH_HOST: process.env.GH_HOST,
    GH_REPO: process.env.GH_REPO,
    GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY,
  };
  let repositoryOverrideIsolation = false;
  try {
    const expected = repositoryTarget(process.cwd());
    process.env.GIT_DIR = '/tmp/autoloop-attacker-git-dir';
    process.env.GH_HOST = 'attacker.invalid';
    process.env.GH_REPO = 'attacker/redirect';
    process.env.GITHUB_REPOSITORY = 'attacker/redirect';
    repositoryOverrideIsolation =
      stableJson(repositoryTarget(process.cwd())) === stableJson(expected);
  } finally {
    for (const [key, value] of Object.entries(originalOverrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const claimRoot = mkdtempSync(join(tmpdir(), 'autoloop-lifecycle-claim-'));
  let partialClaimRecovery = false;
  try {
    command('git', ['init', '-q', '-b', 'main', claimRoot]);
    command('git', ['config', 'user.name', 'Autoloop Test'], {
      cwd: claimRoot,
    });
    command('git', ['config', 'user.email', 'autoloop@example.invalid'], {
      cwd: claimRoot,
    });
    command(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--allow-empty',
        '--no-verify',
        '-m',
        'base',
      ],
      { cwd: claimRoot },
    );
    const plannedBaseOid = command(
      'git',
      ['rev-parse', '--verify', 'main^{commit}'],
      { cwd: claimRoot },
    ).toLowerCase();
    const partialRequest = fakeReconcileRequest();
    partialRequest.intent.planHash = sha256(partialRequest.plan.body);
    partialRequest.intent.branch = 'feat/gh-7-partial';
    partialRequest.intent.plannedBaseOid = plannedBaseOid;
    command(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        'switch',
        '-c',
        partialRequest.intent.branch,
        plannedBaseOid,
      ],
      { cwd: claimRoot },
    );
    const prepared = findClaimCommit(
      claimRoot,
      partialRequest.intent.branch,
      partialRequest.intent.issue,
    );
    ensureLocalClaimGit(claimRoot, partialRequest);
    const recoveredClaim = findClaimCommit(
      claimRoot,
      partialRequest.intent.branch,
      partialRequest.intent.issue,
    );
    partialClaimRecovery =
      prepared.complete
      && !prepared.exists
      && prepared.preparedHeadOid === plannedBaseOid
      && recoveredClaim.complete
      && recoveredClaim.exists
      && recoveredClaim.headOid === recoveredClaim.claimCommit;
  } finally {
    rmSync(claimRoot, { recursive: true, force: true });
  }
  const checks = [
    [
      'fresh lifecycle reconcile persists and binds before resuming',
      recovered.state === 'resume'
        && recovered.action === 'resume-unit'
        && recovered.lifecycleCommentId === 'IC_lifecycle'
        && effects.join(',') ===
          'persist,marker:local-claim,marker:plan-comment,marker:draft-pr',
    ],
    [
      'authenticated revision stages, reads labels, and advances one epoch',
      revisionResult.state === 'complete'
        && revisionResult.epoch === 2
        && revisionMarker.epoch === 2
        && revisionMarker.phase === 'draft-pr'
        && revisionMarker.priorRevisions.length === 1
        && markerWrites === 2,
    ],
    [
      'revision crash replay is idempotent after the durable epoch transition',
      revisionReplay.state === 'complete'
        && revisionReplay.code === 'REVISION_ALREADY_BEGUN'
        && markerWrites === 2,
    ],
    [
      'a changed live head blocks revision before supersession',
      race.state === 'block'
        && race.code === 'REVISION_PREREQUISITE_MISMATCH',
    ],
    [
      'human merge recovery appends one outcome and seals terminal marker',
      mergedRecovery.state === 'complete'
        && mergedRecovery.code === 'LIFECYCLE_COMPLETE'
        && mergedMarker.phase === 'terminal-record'
        && mergedMarker.mergeOid === 'd'.repeat(40)
        && terminalAppends === 1,
    ],
    [
      'driver requests reject caller-authored repository and evidence fields',
      !validateReconcileRequest({ ...request, repository: 'attacker/repo' }),
    ],
    [
      'driver accepts every merge policy the lifecycle contract validates',
      ['manual', 'ratified', 'auto'].every((mergePolicy) =>
        validateReconcileRequest({
          ...request,
          intent: { ...request.intent, mergePolicy },
        }))
      && !validateReconcileRequest({
        ...request,
        intent: { ...request.intent, mergePolicy: 'whenever' },
      }),
    ],
    [
      'repository identity ignores ambient Git and GitHub target overrides',
      repositoryOverrideIsolation,
    ],
    [
      'partial local claim resumes after a switch-before-commit crash',
      partialClaimRecovery,
    ],
  ];
  const failures = checks.filter(([, ok]) => !ok);
  for (const [name] of failures) console.error(`FAIL ${name}`);
  console.log(
    failures.length === 0
      ? `self-test OK (${checks.length} cases)`
      : `self-test FAILED (${checks.length - failures.length}/${checks.length})`,
  );
  return failures.length === 0;
}

function readCliInput(args) {
  if (args.length !== 1) throw new Error('expected one lifecycle driver mode');
  return JSON.parse(readFileSync(0, 'utf8'));
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--self-test') {
    process.exit(selfTest() ? 0 : 1);
  }
  const input = readCliInput(args);
  if (args[0] === '--reconcile-json') {
    process.stdout.write(`${JSON.stringify(driveLifecycle(input))}\n`);
    return;
  }
  if (args[0] === '--begin-revision-json') {
    const context = input.context;
    if (
      !exactKeys(input, ['context', 'request'])
      || !exactKeys(context, ['baseBranch', 'intent', 'plan'])
    ) {
      throw new Error('revision CLI input must contain closed request and context');
    }
    process.stdout.write(`${JSON.stringify(driveLifecycleRevision(
      input.request,
      {
        repositoryRoot: process.cwd(),
        intent: context.intent,
        baseBranch: context.baseBranch,
        plan: context.plan,
      },
    ))}\n`);
    return;
  }
  throw new Error('unknown lifecycle driver mode');
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(`lifecycle-driver: ${error.message}`);
    process.exit(1);
  }
}
