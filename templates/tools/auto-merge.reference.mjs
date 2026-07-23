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

import { execSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

const CORE_QUERY = `
  query($owner:String!, $name:String!, $number:Int!) {
    repository(owner:$owner, name:$name) {
      pullRequest(number:$number) {
        state
        isDraft
        baseRefName
        headRefOid
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

function upper(value) {
  return String(value ?? '').toUpperCase();
}

function errorMessage(error) {
  const parts = [error?.message, error?.stderr, error?.stdout].filter(Boolean);
  return (parts.join(' — ').replace(/\s+/g, ' ').trim() || 'unknown error').slice(0, 500);
}

function ghJson(command, input) {
  const output = execSync(command, {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 15000,
  });
  return JSON.parse(output);
}

function ghGraphql(query, variables) {
  const response = ghJson('gh api graphql --input -', JSON.stringify({ query, variables }));
  if (response.errors?.length) {
    throw new Error(response.errors.map((item) => item.message).join('; '));
  }
  if (!response.data) throw new Error('GraphQL response did not contain data');
  return response.data;
}

// Manual page-by-page pagination: the installed gh lacks `--paginate --slurp`
// (verified live 2026-07-17 — "unknown flag: --slurp"), and bare `--paginate`
// concatenates JSON documents that JSON.parse cannot read. Callers pass
// per_page=100; a short page ends the walk. Page shapes: /pulls/{n}/files → array;
// /commits/{sha}/status → {statuses:[]}; /commits/{sha}/check-runs → {check_runs:[]}.
function ghPaginated(endpoint) {
  const pages = [];
  for (let page = 1; ; page += 1) {
    const data = ghJson(`gh api ${JSON.stringify(`${endpoint}&page=${page}`)}`);
    pages.push(data);
    const items = Array.isArray(data)
      ? data
      : Array.isArray(data?.statuses)
        ? data.statuses
        : Array.isArray(data?.check_runs)
          ? data.check_runs
          : null;
    if (!items) throw new Error('paginated page had an unrecognized shape');
    if (items.length < 100) break;
    if (page >= 50) throw new Error('pagination exceeded 50 pages — refusing rather than truncating');
  }
  return pages;
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
    state: upper(pr.state),
    isDraft: pr.isDraft,
    baseRefName: pr.baseRefName,
    headRefOid: pr.headRefOid,
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

function fetchKillSwitch() {
  try {
    // --repo pins the switch to THIS repository: without it, gh resolves the repo
    // from cwd/GH_REPO, and an invocation from another checkout would consult the
    // wrong repo's issues while merging into this one.
    const output = execSync(
      `gh issue list --repo ${REPO_SLUG} --label automerge:halt --state open --json number --limit 1000`,
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
    state: null,
    isDraft: null,
    baseRefName: null,
    headRefOid: null,
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
    fetchReasons: [],
  };
}

function fetchInputs(number) {
  const inputs = emptyInputs();

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

  const { fetchReasons: killSwitchReasons, ...killSwitch } = fetchKillSwitch();
  Object.assign(inputs, killSwitch);
  inputs.fetchReasons.push(...(killSwitchReasons ?? []));
  return inputs;
}

// Each family is default-deny because it protects a boundary whose risk cannot be
// classified by a label. The tool's own tools/** family can never authorize changes to itself.
// Generic families only — the repo's crown jewels arrive via EXTRA_PROTECTED_PATHS (config).
const PROTECTED_PATH_FAMILIES = [
  // Cryptographic material and algorithms (path segment anywhere in the tree).
  { name: 'cryptographic credential paths', matches: (path) => /(^|\/)[^/]*(?:crypt)[^/]*(?:\/|$)/i.test(path) },
  // Secret/credential/token-bearing path segments anywhere in the tree.
  { name: 'secret/credential path segments', matches: (path) => /(^|\/)[^/]*(?:secret|credential|token)[^/]*(?:\/|$)/i.test(path) },
  // Environment files anywhere.
  { name: 'env files', matches: (path) => /(^|\/)\.env[^/]*$/i.test(path) },
  // Loop, tooling, and enforcement machinery; this tool can never authorize itself.
  { name: 'tools', matches: (path) => /^tools\//i.test(path) },
  // CI workflows and repository automation.
  { name: '.github', matches: (path) => /^\.github\//i.test(path) },
  // Agent skills, hooks, and loop permissions.
  { name: '.claude', matches: (path) => /^\.claude\//i.test(path) },
  { name: '.codex', matches: (path) => /^\.codex\//i.test(path) },
  { name: '.agents', matches: (path) => /^\.agents\//i.test(path) },
  // Any root dotfile or dot-directory is governance or infrastructure by default.
  { name: 'root dotfile/dot-directory', matches: (path) => /^\./.test(path) },
  // Agentic state and loop policy prose — EXCEPT docs/agentic/ARCH.md, which is a curated map
  // (DATA, not policy: no caps/escalate-list/invariants/review-criteria; readers verify every
  // load-bearing claim, imperative text in it is drift). It changes as a normal byproduct of
  // structural units, so protecting it would block their auto-merge for no governance gain. The
  // rest of docs/agentic/ (STATE, checklist, LOOP, digests) stays protected.
  { name: 'docs/agentic', matches: (path) => /^docs\/agentic\//i.test(path) && !/^docs\/agentic\/ARCH\.md$/i.test(path) },
  // Repository critical rules — at ANY depth: both hosts honor nested guidance files.
  { name: 'CLAUDE.md', matches: (path) => /(^|\/)CLAUDE\.md$/i.test(path) },
  { name: 'AGENTS guidance', matches: (path) => /(^|\/)AGENTS(?:\.override)?\.md$/i.test(path) },
  // Local orchestration and service topology.
  { name: 'docker-compose.yml', matches: (path) => /^docker-compose\.yml$/i.test(path) },
  // Image build and deployment boundary.
  { name: 'Dockerfile', matches: (path) => /^Dockerfile[^/]*$/i.test(path) },
  // Dependency manifests at any depth.
  { name: 'package.json', matches: (path) => path.split('/').some((part) => part.toLowerCase() === 'package.json') },
  // Dependency lockfiles at any depth.
  {
    name: 'lockfile',
    matches: (path) => path.split('/').some((part) => /^(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|.+\.lock)$/i.test(part)),
  },
  // TypeScript compiler configuration at any depth.
  { name: 'tsconfig', matches: (path) => /(^|\/)tsconfig[^/]*$/i.test(path) },
  // Build / test-runner / lint tool configuration at any depth.
  { name: 'build/test/lint config', matches: (path) => /(^|\/)(?:vite|vitest|eslint|postcss|tailwind|jest|webpack|rollup)\.config(?:\.[^/]+)?$/i.test(path) },
  // Live data files and runtime persistence.
  { name: 'data files', matches: (path) => /^data\//i.test(path) },
  // Repo crown jewels from the config block (setup mirrors STATE's escalate-list).
  ...EXTRA_PROTECTED_PATHS.map((glob) => ({
    name: `extra-protected ${glob}`,
    matches: (path) => globToRe(glob).test(path),
  })),
];

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
  if (upper(pr.mergeStateStatus) !== 'CLEAN') {
    reasons.push(`mergeStateStatus is not CLEAN (status=${pr.mergeStateStatus ?? 'unknown'})`);
  }

  if (!headRefOid || !/^[0-9a-f]{40}$/i.test(headRefOid)) reasons.push('headRefOid is missing or invalid');
  const statuses = Array.isArray(pr.statuses) ? pr.statuses : [];
  const headStatuses = statuses.filter((status) => status.sha === headRefOid);
  for (const status of statuses) {
    if (status.sha !== headRefOid) reasons.push(`status context ${status.context ?? 'unknown'} is not on fetched headRefOid`);
  }
  const agenticStatuses = headStatuses.filter((status) => String(status.context ?? '').startsWith('agentic/'));
  for (const status of agenticStatuses) {
    if (upper(status.state) !== 'SUCCESS') {
      reasons.push(`agentic status is not SUCCESS: ${status.context}=${status.state ?? 'unknown'}`);
    }
  }
  for (const context of REQUIRED_VERDICTS) {
    if (!headStatuses.some((status) => status.context === context && upper(status.state) === 'SUCCESS')) {
      reasons.push(`missing required ${context}=SUCCESS status on headRefOid`);
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

  const protectedMatches = new Map();
  for (const family of PROTECTED_PATH_FAMILIES) {
    const matchingPaths = paths.filter((path) => family.matches(path));
    if (matchingPaths.length) protectedMatches.set(family.name, [...new Set(matchingPaths)]);
  }
  for (const [family, matchingPaths] of protectedMatches) {
    reasons.push(`protected path (${family}): ${matchingPaths.join(', ')}`);
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

  return { allow: reasons.length === 0, reasons, path };
}

function apiErrorStatus(error) {
  if (Number(error?.status) === 409 || Number(error?.code) === 409) return 409;
  return /(?:HTTP|status|response)[^\d]{0,20}409\b/i.test(errorMessage(error)) ? 409 : null;
}

function defaultMergeExecutor(number) {
  return ({ sha, squash }) => {
    if (squash !== true) throw new Error('merge executor requires squash=true');
    const output = execSync(
      `gh api repos/${REPO_SLUG}/pulls/${number}/merge --method PUT -f merge_method=squash -f sha=${sha}`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000 },
    );
    return JSON.parse(output);
  };
}

function defaultConfirmMerged(number) {
  const output = execSync(`gh api repos/${REPO_SLUG}/pulls/${number}`, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 15000,
  });
  const pr = JSON.parse(output);
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
} = {}) {
  const decision = decide(inputs);
  const result = { exitCode: decision.allow ? 0 : 1, decision, reasons: [...decision.reasons] };
  if (!decision.allow || dryRun) return result;

  const execute = mergeExecutor ?? defaultMergeExecutor(inputs.prNumber);
  const confirm = confirmMerged ?? (() => defaultConfirmMerged(inputs.prNumber));
  const mergeArgs = { sha: inputs.headRefOid, squash: true };
  try {
    const response = execute(mergeArgs);
    // Only an explicit merged=true is success — anything else (false, missing,
    // malformed) is a refusal, never assumed merged.
    if (response?.merged !== true) {
      const message = response?.message ?? 'GitHub did not confirm the merge';
      result.exitCode = 1;
      result.reasons.push(`merge refused by GitHub: ${message}`);
      return result;
    }
    result.merged = true;
    return result;
  } catch (error) {
    const message = errorMessage(error);
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
    result.reasons.push(`LOUD: MERGE OUTCOME UNKNOWN after 3 confirmation attempts; human must inspect immediately (${confirmationReasons.join('; ')})`);
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
  return REQUIRED_CI_CHECKS.map((name) => ({
    name,
    conclusion: 'success',
    head_sha: HEAD_SHA,
    app: { slug: 'github-actions', name: 'GitHub Actions' },
  }));
}

function makeInput({ files = [ALLOWED_PATH], fileEntries, ...overrides } = {}) {
  const entries = fileEntries ?? files.map((filename) => ({ filename, previous_filename: null }));
  return {
    prNumber: 138,
    state: 'OPEN',
    isDraft: false,
    baseRefName: BASE_BRANCH,
    headRefOid: HEAD_SHA,
    headRepository: { owner: REPOSITORY.owner, name: REPOSITORY.name },
    labels: [],
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
    statuses: REQUIRED_VERDICTS.map((context) => ({ context, state: 'success', sha: HEAD_SHA })),
    checkRuns: makeCheckRuns(),
    rollupComplete: true,
    killSwitch: { known: true, active: false },
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
  { name: 'missing gate verdict on Path A', input: makeInput({ labels: ['risk:pure-deletion'], statuses: [{ context: 'agentic/review', state: 'success', sha: HEAD_SHA }] }), expectExit: 1, expectCalls: 0 },
  { name: 'failing review on Path A', input: makeInput({ labels: ['risk:pure-deletion'], statuses: [{ context: 'agentic/gate', state: 'success', sha: HEAD_SHA }, { context: 'agentic/review', state: 'failure', sha: HEAD_SHA }] }), expectExit: 1, expectCalls: 0 },
  { name: 'missing verdict on Path B', input: makeInput({ statuses: [{ context: 'agentic/gate', state: 'success', sha: HEAD_SHA }] }), expectExit: 1, expectCalls: 0 },
  { name: 'non-success agentic status', input: makeInput({ statuses: [...makeInput().statuses, { context: 'agentic/extra', state: 'failure', sha: HEAD_SHA }] }), expectExit: 1, expectCalls: 0 },
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
        { name: 'missing CI check', input: makeInput({ checkRuns: makeCheckRuns().slice(1) }), expectExit: 1, expectCalls: 0 },
        {
          name: 'user-posted (non-CheckRun) CI context',
          input: makeInput({ statuses: [...makeInput().statuses, { context: REQUIRED_CI_CHECKS[0], state: 'success', sha: HEAD_SHA }] }),
          expectExit: 1,
          expectCalls: 0,
        },
        {
          name: 'duplicate CI context',
          input: makeInput({ checkRuns: [makeCheckRuns()[0], makeCheckRuns()[0], ...makeCheckRuns().slice(1)] }),
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
  return cases;
}

function selfTest() {
  let passed = 0;
  let failed = 0;
  for (const check of statusStampCases()) {
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
        if (fixture.mergeBehavior === 'timeout') throw Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' });
        return { merged: true };
      },
      confirmMerged: () => {
        confirmCalls += 1;
        return fixture.confirmMerged ?? { merged: false, headSha: null };
      },
      sleep: () => {},
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
  if (!dryRun) console.log(`MERGED #${number} (squash, sha=${inputs.headRefOid})`);
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
