#!/usr/bin/env node
// One-call run scan for the autoloop (vendored by autoloop:setup).
//
// Prime + pitcrew + step-1 selection previously derived state through 15-25 serial gh
// calls with a model turn between each — observed 5 minutes from invocation to first
// issue pick. This tool batches the whole derivation into ONE invocation and emits a
// single JSON document. The orchestrator still applies every judgment rule (trusted
// labeler, edited-after-label, blocked-by, orphan provenance) — this gathers the facts,
// it never decides.
//
// Fail-open per section: a failed gh call yields {"error": "..."} for that section and
// the orchestrator falls back to targeted calls for it; a scan must never wedge a run.
//
// Usage:
//   node tools/agentic/scan.mjs            # run scan: JSON to stdout
//   node tools/agentic/scan.mjs --pr <N>   # one PR's revise facts: threads, reviews, author roles
//   node tools/agentic/scan.mjs --self-test

import { execSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LOOP_BRANCH_RE = /^(feat|fix|chore|docs|refactor|test|perf|build|ci)\/gh-(\d+)-/;
// Loop-owned claim: closing keyword (optional colon) + `#N`. KEEP IN SYNC with loop-scope.mjs.
const CLOSES_RE = /\b(clos(e|es|ed)|fix(es|ed)?|resolv(e|es|ed)):?\s+#(\d+)/i;

function sh(cmd, timeout = 20000) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout });
}

function ghJson(cmd) {
  try {
    return { ok: true, data: JSON.parse(sh(`gh ${cmd}`)) };
  } catch (error) {
    return { ok: false, error: String(error.message).slice(0, 200) };
  }
}

/** Pure: classify open PRs into loop-owned / drafts (orphan candidates) / human. */
export function classifyPrs(prs) {
  const loopOwned = [];
  const human = [];
  for (const pr of prs ?? []) {
    const branchMatch = LOOP_BRANCH_RE.exec(pr.headRefName ?? '');
    const closes = CLOSES_RE.exec(pr.body ?? '');
    if (branchMatch && closes) {
      loopOwned.push({ ...pr, issue: Number(closes[5] ?? closes[4]), orphanCandidate: !!pr.isDraft });
    } else {
      human.push({ number: pr.number, headRefName: pr.headRefName });
    }
  }
  return { loopOwned, human };
}

/** Pure: extract the LAST loop-ready labeled event from a timeline. */
export function labelProvenance(timeline) {
  const events = (timeline ?? []).filter(
    (e) => e.event === 'labeled' && e.label?.name === 'loop-ready',
  );
  const last = events[events.length - 1];
  return last ? { labeledBy: last.actor?.login ?? null, labeledAt: last.created_at ?? null } : null;
}

/** Pure: pull "## Blocked by" issue refs out of a body. */
export function blockedBy(body) {
  const section = /##\s*Blocked by([\s\S]*?)(\n##\s|$)/i.exec(body ?? '');
  if (!section) return [];
  return [...section[1].matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
}

function selfTest() {
  const prs = [
    { number: 1, headRefName: 'feat/gh-7-x', body: 'Closes #7', isDraft: true },
    { number: 2, headRefName: 'feat/gh-8-y', body: 'Closes #8', isDraft: false },
    { number: 3, headRefName: 'feature/TMSLA-1', body: 'Closes #9', isDraft: false },
    { number: 4, headRefName: 'fix/gh-9-z', body: 'no claim', isDraft: false },
  ];
  const { loopOwned, human } = classifyPrs(prs);
  const prov = labelProvenance([
    { event: 'labeled', label: { name: 'loop-ready' }, actor: { login: 'a' }, created_at: 't1' },
    { event: 'labeled', label: { name: 'loop-blocked' }, actor: { login: 'x' }, created_at: 't2' },
    { event: 'labeled', label: { name: 'loop-ready' }, actor: { login: 'b' }, created_at: 't3' },
  ]);
  const blocked = blockedBy('body\n## Blocked by\n- #12\n- #34\n\n## Next\n#99');
  const ok =
    loopOwned.length === 2 && loopOwned[0].issue === 7 && loopOwned[0].orphanCandidate === true &&
    loopOwned[1].issue === 8 && loopOwned[1].orphanCandidate === false &&
    human.length === 2 &&
    prov.labeledBy === 'b' && prov.labeledAt === 't3' &&
    labelProvenance([]) === null &&
    blocked.length === 2 && blocked[0] === 12 && blocked[1] === 34 &&
    blockedBy('no section #5').length === 0;
  console.log(ok ? 'self-test OK (4 groups)' : 'self-test FAILED');
  return ok;
}

function prReport(prNumber) {
  const out = { pr: prNumber };
  const view = ghJson(
    `pr view ${prNumber} --json number,title,isDraft,reviewDecision,headRefName,headRefOid,mergeStateStatus,statusCheckRollup,body,reviews`,
  );
  out.view = view.ok ? view.data : { error: view.error };

  const repo = ghJson('repo view --json owner,name');
  if (repo.ok) {
    const threads = ghJson(
      `api graphql -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100){nodes{id isResolved path line comments(first:20){nodes{author{login} body}}}}}}}' -F o="${repo.data.owner.login}" -F r="${repo.data.name}" -F n=${prNumber}`,
    );
    out.threads = threads.ok
      ? threads.data.data.repository.pullRequest.reviewThreads.nodes
      : { error: threads.error };
  } else {
    out.threads = { error: repo.error };
  }

  const authors = new Set();
  for (const review of out.view?.reviews ?? []) if (review.author?.login) authors.add(review.author.login);
  if (Array.isArray(out.threads)) {
    for (const thread of out.threads) {
      for (const comment of thread.comments?.nodes ?? []) if (comment.author?.login) authors.add(comment.author.login);
    }
  }
  out.authorRoles = {};
  for (const login of authors) {
    const perm = ghJson(`api repos/{owner}/{repo}/collaborators/${login}/permission`);
    out.authorRoles[login] = perm.ok ? perm.data.role_name ?? perm.data.permission : { error: perm.error };
  }
  console.log(JSON.stringify(out, null, 1));
}

function main() {
  if (process.argv.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  const prFlag = process.argv.indexOf('--pr');
  if (prFlag !== -1) {
    const n = Number(process.argv[prFlag + 1]);
    if (!Number.isInteger(n) || n <= 0) {
      console.log('FAIL  scan: --pr requires a positive PR number');
      process.exit(2);
    }
    return prReport(n);
  }

  const out = { scannedAt: new Date().toISOString() };

  const repo = ghJson('repo view --json nameWithOwner,defaultBranchRef');
  out.repo = repo.ok
    ? { nameWithOwner: repo.data.nameWithOwner, defaultBranch: repo.data.defaultBranchRef?.name }
    : { error: repo.error };

  try {
    out.tree = {
      dirtyPaths: sh('git status --porcelain=v1 --untracked-files=all').split('\n').filter(Boolean).length,
      branch: sh('git rev-parse --abbrev-ref HEAD').trim(),
      head: sh('git rev-parse HEAD').trim(),
    };
  } catch (error) {
    out.tree = { error: String(error.message).slice(0, 200) };
  }

  const prs = ghJson(
    'pr list --state open --json number,title,isDraft,reviewDecision,headRefName,mergeStateStatus,statusCheckRollup,body,author --limit 50',
  );
  out.prs = prs.ok ? classifyPrs(prs.data) : { error: prs.error };

  const issues = ghJson(
    'issue list --label loop-ready --state open --json number,title,body,updatedAt --limit 50',
  );
  if (!issues.ok) {
    out.queue = { error: issues.error };
  } else {
    const labelers = new Set();
    out.queue = issues.data.map((issue) => {
      const timeline = ghJson(`api repos/{owner}/{repo}/issues/${issue.number}/timeline --paginate`);
      const provenance = timeline.ok ? labelProvenance(timeline.data) : null;
      if (provenance?.labeledBy) labelers.add(provenance.labeledBy);
      return {
        number: issue.number,
        title: issue.title,
        updatedAt: issue.updatedAt,
        blockedBy: blockedBy(issue.body),
        provenance: provenance ?? { error: timeline.ok ? 'no loop-ready label event' : timeline.error },
      };
    });
    out.labelerRoles = {};
    for (const login of labelers) {
      const perm = ghJson(`api repos/{owner}/{repo}/collaborators/${login}/permission`);
      out.labelerRoles[login] = perm.ok ? perm.data.role_name ?? perm.data.permission : { error: perm.error };
    }
  }

  const blocked = ghJson('issue list --label loop-blocked --state open --json number --limit 50');
  out.blocked = blocked.ok ? blocked.data.map((issue) => issue.number) : { error: blocked.error };

  const openAll = ghJson('issue list --state open --json number --limit 100');
  out.openIssues = openAll.ok ? openAll.data.map((issue) => issue.number) : { error: openAll.error };

  const merged = ghJson('pr list --state merged --json number,headRefName,body,isDraft --limit 20');
  out.mergedLoopOwned = merged.ok
    ? classifyPrs(merged.data).loopOwned.map((pr) => ({ number: pr.number, issue: pr.issue }))
    : { error: merged.error };

  // Silent truncation is a correctness hazard: a list at its --limit cap may be missing items the
  // loop needs to see (queue eligibility, close-out reconciliation). Surface it rather than hide it.
  out.truncated = [];
  const capWarn = (res, cap, what) => {
    if (res.ok && Array.isArray(res.data) && res.data.length >= cap) {
      out.truncated.push(`${what} hit the ${cap}-item cap — list may be incomplete; narrow the query or paginate`);
    }
  };
  capWarn(prs, 50, 'open PRs');
  capWarn(issues, 50, 'loop-ready queue');
  capWarn(blocked, 50, 'loop-blocked issues');
  capWarn(openAll, 100, 'open issues');
  capWarn(merged, 20, 'merged PRs');

  console.log(JSON.stringify(out, null, 1));
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
