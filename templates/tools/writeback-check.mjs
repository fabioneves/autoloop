#!/usr/bin/env node
// Stop-hook write-back contract check for the autoloop. The loop reconstructs its entire state from git/GitHub every run
// (queued / in-progress / blocked are derived from labels and `Closes #N` bodies), so
// a crashed run that skipped its Record step silently corrupts state re-derivation
// for every future run — and nothing else would ever notice.
//
// Hard gaps (exit 2 — the host agent is re-invoked ONCE with the gap listed, fixes it, and the
// next Stop passes; `stop_hook_active` prevents any loop):
//   - an open PR on a loop branch (<type>/gh-<N>-…) whose body lacks "Closes #N"
//   - an open issue labelled loop-blocked with zero comments (no reason recorded)
//   - an open loop PR carrying commits that exist only in the local checkout: the
//     unit was abandoned mid-flight. A live 0.42.3 run ended its turn at step 8
//     of 11 with four such commits and every guard stayed quiet — clean tree,
//     draft PR (a reminder, below), and step labels never advanced past claim so
//     the unit did not look mid-flight. This one is a pure `git rev-list --count`
//     against the tracking ref, so it costs none of the GraphQL that made the
//     draft check too expensive to harden.
//   - an open loop PR with commits pushed beyond its claim whose issue still
//     advertises a step at or before claim: the step timeline stalled, and the
//     next run reconciles against that stale phase. The commit count is read from
//     the local tracking refs; asking GitHub for it cost a 100-commit page per PR
//     and blew the node budget, which silently killed every check in this list.
//   - a LIVE run ending its turn with eligible units left in the queue: the run
//     went dark. Every gap above catches an abandoned UNIT; this one catches an
//     abandoned RUN, which no unit-shaped evidence can see because each unit is
//     perfectly terminal. A live 0.49.58 run delivered two units, printed no
//     closing rail, and idled with thirteen dependency-free units queued; the
//     prose rule it broke is written three times in the Dev skill and had
//     already failed once before (0.42.3, step 8 of 11). The run's own
//     `prime.mjs --close-run` is the escape when the queue is not the reason to
//     stop.
//
// Reminders (JSON systemMessage on stdout, exit 0 — never block):
//   - a claimed loop PR still in draft (may be mid-unit OR a forgotten autoloop:dev step 10;
//     a stricter variant hard-fails this — we deliberately soften it because thread/CI state needs
//     GraphQL and step 10 / the pitcrew own readiness)
//   - an issue wearing a terminal loop label (loop-delivered / loop-blocked) plus a leftover
//     loop:* step label — a crashed or sloppy terminal transition stranded the step timeline
//
// Loop-safety: read-only; self-clearing (fill the gap → next run passes); fail-open on
// every infrastructure error (gh missing, offline, rate-limited) — a Stop hook must
// never wedge a session. --self-test runs the pure-function fixtures.
//
// Host contract: the wire shape (stdin `stop_hook_active`, stdout `{systemMessage}`) is Claude
// Code's Stop-hook contract. Codex's hooks feature deliberately mirrors Claude's (verified for
// tool naming in codex-rs hook_names.rs @ 0.144.5); `stop_hook_active` mirroring is assumed,
// not verified — if a Codex session ever re-blocks the same Stop repeatedly, this assumption
// broke and the guard should be re-verified against the Codex hooks docs.

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { LOOP_BRANCH_RE, parseLoopClaim } from './claim-contract.mjs';
import { loopRunIsLive } from './command-guard.mjs';
import { blockedByIssueNumbers } from './snapshot-contract.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function ghJson(cmd) {
  try {
    const out = execFileSync('gh', cmd.split(' '), {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: ROOT,
      timeout: 15000,
    });
    return JSON.parse(out);
  } catch {
    return null; // fail-open: any gh error skips the check
  }
}

/** Pure: classify PRs → { hard: string[], reminders: string[] } */
export function checkPrs(prs) {
  const hard = [];
  const reminders = [];
  for (const pr of prs ?? []) {
    if (!LOOP_BRANCH_RE.test(pr.headRefName ?? '')) continue;
    const claim = parseLoopClaim({ branch: pr.headRefName, body: pr.body });
    if (!claim.valid) {
      hard.push(
        `PR #${pr.number} (${pr.headRefName}) has invalid loop ownership (${claim.reasonCode}) — make its single closing claim match the branch issue`,
      );
    } else if (pr.isDraft) {
      reminders.push(`PR #${pr.number} (${pr.headRefName}) is claimed but still draft — mid-unit, or a forgotten \`gh pr ready\` (autoloop:dev step 10)?`);
    }
  }
  return { hard, reminders };
}

/** Pure: open loop PRs carrying commits that exist only in the local checkout.
 *
 *  A live 0.42.3 run ended its turn at step 8 of 11 with four commits stranded
 *  locally, and all three guards had a reason to stay quiet: the tree was clean,
 *  the draft-PR case is deliberately a reminder rather than a gap, and the step
 *  labels had never advanced past claim so the unit did not look mid-flight.
 *
 *  Unpushed work under an open loop PR is the fact none of that ambiguity
 *  touches. It is also purely local — `git rev-list --count` against the remote
 *  tracking ref — so it costs no GraphQL, which is the reason the draft check
 *  was softened in the first place. `unpushedFor` returns null when the
 *  comparison is unanswerable (branch absent locally, no remote ref yet); that
 *  is skipped rather than guessed at. */
export function checkUnpushedLoopWork(prs, unpushedFor) {
  const hard = [];
  for (const pr of prs ?? []) {
    if (!LOOP_BRANCH_RE.test(pr.headRefName ?? '')) continue;
    const ahead = unpushedFor(pr.headRefName);
    if (!Number.isSafeInteger(ahead) || ahead <= 0) continue;
    hard.push(
      `PR #${pr.number} (${pr.headRefName}) has ${ahead} commit(s) only in the local checkout `
      + '— the unit is unfinished and its work is stranded; push and carry the unit to a '
      + 'terminal state (delivered / blocked) instead of ending the turn',
    );
  }
  return hard;
}

/** Pure: an open loop PR with work pushed beyond its claim commit, whose issue
 *  still advertises a step at or before claim.
 *
 *  The dispatch anchor in `label-swap-reminder.mjs` catches a skipped swap at the
 *  moment the step runs, but a run that ignores it leaves the issue lying about
 *  where the unit is — and the next run reconciles against that lie. A pushed PR
 *  with two or more commits has demonstrably moved past claim, so a step label of
 *  `04-claim` or earlier is drift, not a race.
 *
 *  The count is injected and answered from the local tracking refs. It used to
 *  ride along on the PR query as a `commits` field, which asks GitHub for a
 *  100-commit page per pull request: at `--limit 50` that is 505,050 possible
 *  nodes against a 500,000 budget, so on a repository with four open PRs the
 *  whole query failed, `prs` hydrated null, and EVERY PR-side gap in this file
 *  went silently dead. A count that cannot be answered is skipped, never
 *  guessed at. */
export function checkStepLabelDrift(prs, issues, commitCountFor) {
  const labelsFor = new Map(
    (issues ?? []).map((issue) => [issue.number, (issue.labels ?? []).map(({ name }) => name)]),
  );
  const hard = [];
  for (const pr of prs ?? []) {
    if (!LOOP_BRANCH_RE.test(pr.headRefName ?? '')) continue;
    const commits = commitCountFor(pr);
    if (!Number.isSafeInteger(commits) || commits < 2) continue;
    const claim = parseLoopClaim({ branch: pr.headRefName, body: pr.body });
    if (!claim.valid) continue; // already reported as invalid ownership
    const labels = labelsFor.get(claim.issue);
    if (labels === undefined) continue;
    const steps = labels
      .filter((name) => /^loop:\d\d-/.test(name))
      .map((name) => Number(name.slice(5, 7)));
    if (steps.length === 0 || Math.max(...steps) > 4) continue;
    hard.push(
      `Issue #${claim.issue} still advertises step ${Math.max(...steps)} while PR #${pr.number} `
      + `has ${commits} pushed commits — the step timeline stalled at claim; swap the `
      + 'current `loop:NN-*` label so the next run reconciles against the real phase',
    );
  }
  return hard;
}

/** Pure: name the checks a failed query silenced.
 *
 *  Every fetch here fails open, which is right for a Stop hook and wrong to do
 *  quietly: a hook that checks nothing looks exactly like a repository with
 *  nothing to report. */
export function checkSkippedQueries(available) {
  const silenced = [
    ['openPrs', 'the open pull requests', 'ownership, unpushed-work and step-drift gaps'],
    ['blockedIssues', 'the loop-blocked issues', 'the missing-reason gap'],
    ['mergedPrs', 'the merged pull requests', 'the unclosed-issue reminder'],
    ['openIssues', 'the open issues', 'stranded step labels, step drift and run liveness'],
  ];
  return silenced
    .filter(([key]) => available?.[key] !== true)
    .map(([, subject, checks]) => `${subject} could not be listed — ${checks} were NOT checked this stop`);
}

/** Local-only: `git rev-list --count`, or null when the range is unanswerable
 *  (unknown branch, no remote ref, no git) — never a guess.
 *
 *  No shell. A ref name may legally contain `$`, a backtick, or a quote, and the
 *  PR base ref that reaches this function passes through no branch pattern at
 *  all — anyone who can open a pull request chooses it. Quoting a ref into a
 *  shell string is one escape away from executing it; argv has no such edge. */
function revListCount(range) {
  try {
    const out = execFileSync('git', ['rev-list', '--count', range], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15000,
    });
    const count = Number(String(out).trim());
    return Number.isSafeInteger(count) ? count : null;
  } catch {
    return null;
  }
}

/** Commits on the branch that the remote tracking ref does not have. */
function unpushedCommitCount(branch) {
  return revListCount(`refs/remotes/origin/${branch}..refs/heads/${branch}`);
}

/** Commits the PR's head carries beyond its base, both read from the remote
 *  tracking refs. */
function pushedCommitCount(pr) {
  const { baseRefName: base, headRefName: head } = pr ?? {};
  if (!base || !head || typeof base !== 'string' || typeof head !== 'string') return null;
  return revListCount(`refs/remotes/origin/${base}..refs/remotes/origin/${head}`);
}

/** Pure: merged loop PRs whose linked issue is still open. On a PR that does not target the
 *  DEFAULT branch, GitHub IGNORES closing keywords entirely — no link is created and the issue
 *  will never close on its own (verified: closingIssuesReferences is empty for such PRs). For a
 *  loop based on any other branch, this check IS the closing mechanism, not a safety net —
 *  without it, issues leak open forever and `## Blocked by` chains stall on landed work. */
export function checkMergedClosedGap(mergedPrs, openIssueNumbers) {
  const open = new Set(openIssueNumbers ?? []);
  const reminders = [];
  for (const pr of mergedPrs ?? []) {
    if (!LOOP_BRANCH_RE.test(pr.headRefName ?? '')) continue;
    const claim = parseLoopClaim({ branch: pr.headRefName, body: pr.body });
    if (!claim.valid) {
      reminders.push(
        `Merged loop PR #${pr.number} has invalid ownership (${claim.reasonCode}) — reconcile its branch/body issue manually`,
      );
      continue;
    }
    const issue = claim.issue;
    if (open.has(issue)) {
      reminders.push(`Issue #${issue} is still OPEN but its loop PR #${pr.number} has MERGED — GitHub ignores closing keywords on non-default-base PRs (no link is ever created; it will NEVER close on its own): gh issue close ${issue} --comment "Merged via PR #${pr.number}"`);
    }
  }
  return reminders;
}

/** Pure: issues wearing a terminal loop label AND leftover step labels → reminders */
export function checkStrandedStepLabels(issues) {
  const reminders = [];
  for (const issue of issues ?? []) {
    const names = (issue.labels ?? []).map((l) => l?.name ?? l);
    const terminal = names.find((n) => n === 'loop-delivered' || n === 'loop-blocked');
    if (!terminal) continue;
    const stranded = names.filter((n) => typeof n === 'string' && n.startsWith('loop:'));
    if (stranded.length) {
      reminders.push(
        `Issue #${issue.number} wears ${terminal} plus stranded step label(s) ${stranded.join(', ')} — ` +
        `remove them: gh issue edit ${issue.number} ${stranded.map((s) => `--remove-label ${s}`).join(' ')}`,
      );
    }
  }
  return reminders;
}

/** Pure: classify loop-blocked issues → hard gaps */
export function checkBlockedIssues(issues) {
  return (issues ?? [])
    .filter((i) => (i.comments?.length ?? i.comments ?? 0) === 0)
    .map((i) => `Issue #${i.number} is loop-blocked with NO comment — record the reason + gate label (STATE → Defer)`);
}

/** Pure: a live run ending its turn while the queue still holds work it could take.
 *
 *  Eligibility is deliberately narrower than the loop's own selection rule. A
 *  false positive here argues with a run that stopped for a reason the hook
 *  cannot see — a spent context budget, an invocation bound — so every doubtful
 *  unit is dropped rather than counted: terminal labels, any human-owned label,
 *  an open `## Blocked by` dependency, and anything an open loop PR already
 *  claims. What survives is work the run had no account of.
 *
 *  `runIsLive` is passed in rather than read here so the classifier stays pure;
 *  main() answers it from the run marker prime wrote. */
export function checkDarkRun(runIsLive, issues, prs) {
  if (runIsLive !== true) return [];
  const claimed = new Set(
    (prs ?? [])
      .filter((pr) => LOOP_BRANCH_RE.test(pr.headRefName ?? ''))
      .map((pr) => parseLoopClaim({ branch: pr.headRefName, body: pr.body }))
      .filter((claim) => claim.valid)
      .map((claim) => claim.issue),
  );
  const openNumbers = new Set((issues ?? []).map((issue) => issue.number));
  const eligible = [];
  for (const issue of issues ?? []) {
    const names = (issue.labels ?? []).map((label) => label?.name ?? label);
    if (!names.includes('loop-ready')) continue;
    if (names.some((name) => typeof name === 'string' && (
      name === 'loop-delivered'
      || name === 'loop-blocked'
      || name === 'needs-human'
      || name.startsWith('human:')
    ))) continue;
    if (claimed.has(issue.number)) continue;
    if (blockedByIssueNumbers(issue.body).some((dependency) => openNumbers.has(dependency))) continue;
    eligible.push(issue.number);
  }
  if (eligible.length === 0) return [];
  const named = eligible.slice(0, 8).map((number) => `#${number}`).join(', ');
  const rest = eligible.length > 8 ? `, +${eligible.length - 8} more` : '';
  return [
    `The run is still open and ${eligible.length} eligible unit(s) are queued (${named}${rest}) `
    + '— this turn ended without taking one. A unit that needs a human is a row in the digest, '
    + 'not a reason to stop: take the next unit. If the queue is genuinely not why this run is '
    + 'stopping — a human asked for the session back, the context needs handing off, an '
    + 'invocation bound was reached — then close the run on the record instead, and stop: '
    + '`node tools/agentic/prime.mjs --close-run`',
  ];
}

/** Pure: render the exact Stop-hook wire result. Reminders ride the hard-gap
 *  stderr too — a blocking Stop must never swallow them. */
export function renderHookResult(hard, reminders) {
  if ((hard?.length ?? 0) > 0) {
    const reminderTail =
      (reminders?.length ?? 0) > 0
        ? 'Also (reminders, non-blocking):\n' + reminders.map((r) => `  - ${r}`).join('\n') + '\n'
        : '';
    return {
      exitCode: 2,
      stdout: '',
      stderr:
        'Write-back contract gaps (loop state is derived from GitHub — fix these now):\n' +
        hard.map((g) => `  - ${g}`).join('\n') +
        '\n' +
        reminderTail,
    };
  }
  if ((reminders?.length ?? 0) > 0) {
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        systemMessage: reminders.map((r) => `writeback reminder: ${r}`).join('\n'),
      }),
      stderr: '',
    };
  }
  return { exitCode: 0, stdout: '', stderr: '' };
}

function selfTest() {
  const prs = [
    { number: 1, headRefName: 'feat/gh-1-x', body: 'Closes #1', isDraft: false },
    { number: 2, headRefName: 'feat/gh-2-y', body: 'no claim', isDraft: false },
    { number: 3, headRefName: 'fix/gh-3-z', body: 'Fixes #3', isDraft: true },
    { number: 4, headRefName: 'hardening/human-branch', body: 'no claim', isDraft: false },
    { number: 5, headRefName: 'fix/gh-5-colon', body: 'Closes: #5', isDraft: false },
    { number: 6, headRefName: 'fix/gh-6-mismatch', body: 'Closes #7', isDraft: false },
  ];
  const { hard, reminders } = checkPrs(prs);
  // A live 0.42.3 run ended its turn at step 8 of 11 with four commits sitting
  // only in the local checkout. Nothing objected: the tree was clean, the PR was
  // draft (a reminder, not a gap), and the step labels had never advanced past
  // claim so the unit did not even look mid-flight. Unpushed work under an open
  // loop PR is the one fact that was unambiguous, and it is purely local.
  const unpushed = checkUnpushedLoopWork(prs, (branch) => ({
    'feat/gh-1-x': 0,
    'fix/gh-3-z': 4,
    'hardening/human-branch': 9,
    'fix/gh-5-colon': null,
  })[branch] ?? 0);
  const mergedGap = checkMergedClosedGap(
    [
      { number: 20, headRefName: 'feat/gh-7-a', body: 'Closes #7' },
      { number: 21, headRefName: 'feat/gh-8-b', body: 'Closes #8' },
      { number: 22, headRefName: 'feature/human', body: 'Closes #9' },
      { number: 23, headRefName: 'feat/gh-10-mismatch', body: 'Closes #11' },
    ],
    [7, 9, 15],
  );
  const blocked = checkBlockedIssues([
    { number: 9, comments: [] },
    { number: 10, comments: [{ body: 'reason' }] },
    { number: 11, comments: 3 },
    { number: 12, comments: 0 },
  ]);
  // Two pushed commits with the issue still at claim is drift; one pushed commit
  // is just the claim itself, and a step past claim is healthy.
  const drift = checkStepLabelDrift(
    [
      { number: 30, headRefName: 'feat/gh-30-a', baseRefName: 'main', body: 'Closes #30' },
      { number: 31, headRefName: 'feat/gh-31-b', baseRefName: 'main', body: 'Closes #31' },
      { number: 32, headRefName: 'feat/gh-32-c', baseRefName: 'main', body: 'Closes #32' },
      { number: 33, headRefName: 'feat/gh-33-d', baseRefName: 'main', body: 'Closes #33' },
      { number: 34, headRefName: 'feat/gh-34-e', baseRefName: 'main', body: 'Closes #34' },
    ],
    [
      { number: 30, labels: [{ name: 'loop-started' }, { name: 'loop:04-claim' }] },
      { number: 31, labels: [{ name: 'loop:04-claim' }] },
      { number: 32, labels: [{ name: 'loop:08-code-review' }] },
      { number: 33, labels: [{ name: 'loop:04-claim' }] },
      { number: 34, labels: [{ name: 'loop:04-claim' }] },
    ],
    // Both shapes an unanswerable count can take: absent, and not a number at
    // all. `NaN < 2` is false, so arithmetic alone would let it through and
    // report "NaN pushed commits" as drift.
    (pr) => ({ 33: null, 34: Number.NaN })[pr.number] ?? { 30: 3, 31: 1, 32: 2 }[pr.number],
  );
  const skipped = checkSkippedQueries({ openPrs: false, blockedIssues: true, mergedPrs: true, openIssues: false });
  // The 0.49.58 run that motivated this gap: two units delivered and human-gated,
  // thirteen dependency-free units still queued, nothing in flight, and the turn
  // ended anyway. Every exclusion below is a unit that run should NOT have been
  // told to take: a delivered one, a blocked one, one a human owns, one whose
  // dependency is still open, and one already claimed by an open PR.
  const dark = checkDarkRun(
    true,
    [
      { number: 40, labels: [{ name: 'loop-ready' }], body: 'no deps' },
      { number: 41, labels: [{ name: 'loop-ready' }, { name: 'loop-delivered' }], body: '' },
      { number: 42, labels: [{ name: 'loop-ready' }, { name: 'loop-blocked' }], body: '' },
      { number: 43, labels: [{ name: 'loop-ready' }, { name: 'human:decide' }], body: '' },
      { number: 44, labels: [{ name: 'loop-ready' }], body: '## Blocked by\n- #40\n' },
      { number: 45, labels: [{ name: 'loop-ready' }], body: '## Blocked by\n- #99\n' },
      { number: 46, labels: [{ name: 'loop-ready' }], body: '' },
      { number: 47, labels: [{ name: 'loop-started' }], body: '' },
    ],
    [{ number: 60, headRefName: 'feat/gh-46-x', body: 'Closes #46' }],
  );
  const stranded = checkStrandedStepLabels([
    { number: 7, labels: [{ name: 'loop-ready' }, { name: 'loop-delivered' }, { name: 'loop:04-claim' }, { name: 'loop:07-diff-review' }] },
    { number: 8, labels: [{ name: 'loop-delivered' }] },
    { number: 9, labels: [{ name: 'loop:05-implement' }, { name: 'loop-started' }] },
  ]);
  // Every child in this file goes through one primitive, and a self-test that
  // never names it let an undefined import ship silently: `ghJson` caught the
  // ReferenceError, returned null for every query, and the hook exited 0 having
  // checked nothing.
  const childPrimitiveDefined = typeof execFileSync === 'function';
  const reminderWire = renderHookResult([], reminders);
  const hardWire = renderHookResult([...hard, ...blocked], reminders);
  let reminderJson;
  try {
    reminderJson = JSON.parse(reminderWire.stdout);
  } catch {
    reminderJson = null;
  }
  const ok =
    childPrimitiveDefined &&
    hard.length === 2 && hard[0].includes('#2') && hard[1].includes('#6') &&
    reminders.length === 1 && reminders[0].includes('#3') &&
    mergedGap.length === 2 && mergedGap[0].includes('#7') && mergedGap[0].includes('PR #20') &&
    mergedGap[1].includes('PR #23') && mergedGap[1].includes('ISSUE_MISMATCH') &&
    blocked.length === 2 && blocked[0].includes('#9') && blocked[1].includes('#12') &&
    // Only the loop-branch PR with local-only commits: a pushed loop branch is
    // silent, a non-loop branch is never this hook's business, and an
    // unanswerable ref comparison is skipped rather than guessed at.
    unpushed.length === 1 && unpushed[0].includes('#3') && unpushed[0].includes('4') &&
    drift.length === 1 && drift[0].includes('#30') && drift[0].includes('PR #30') &&
    // An unanswerable commit count is skipped, never guessed at — the same rule
    // the unpushed check has always applied to a missing tracking ref.
    !drift.some((gap) => gap.includes('#33') || gap.includes('#34') || gap.includes('NaN')) &&
    // A query that could not run says so: this hook fetched a 100-commit page per
    // PR for a >= 2 comparison, blew GitHub's 500,000-node budget on a repository
    // with four open PRs, and every PR-side gap went quietly dead.
    skipped.length === 2 && skipped[0].includes('open pull requests') && skipped[1].includes('open issues') &&
    checkSkippedQueries({ openPrs: true, blockedIssues: true, mergedPrs: true, openIssues: true }).length === 0 &&
    // #40 (clean) and #45 (its only dependency is closed) are the whole eligible
    // set; a closed run and an empty set are both silent.
    dark.length === 1 && dark[0].includes('#40') && dark[0].includes('#45') &&
    dark[0].includes('2 eligible') && dark[0].includes('--close-run') &&
    !dark[0].includes('#41') && !dark[0].includes('#42') && !dark[0].includes('#43') &&
    !dark[0].includes('#44') && !dark[0].includes('#46') && !dark[0].includes('#47') &&
    checkDarkRun(false, [{ number: 40, labels: [{ name: 'loop-ready' }], body: '' }], []).length === 0 &&
    checkDarkRun(true, [], []).length === 0 &&
    stranded.length === 1 && stranded[0].includes('#7') && stranded[0].includes('loop:04-claim') &&
    stranded[0].includes('--remove-label loop:07-diff-review') &&
    reminderWire.exitCode === 0 && reminderWire.stderr === '' &&
    Object.keys(reminderJson ?? {}).length === 1 &&
    reminderJson?.systemMessage?.includes('writeback reminder: PR #3') &&
    hardWire.exitCode === 2 && hardWire.stdout === '' &&
    hardWire.stderr.includes('Write-back contract gaps') &&
    hardWire.stderr.includes('PR #3') &&
    renderHookResult(['gap'], []).stderr.includes('reminders') === false;
  console.log(ok ? 'self-test OK' : `self-test FAILED: ${JSON.stringify({ hard, reminders, blocked, dark, reminderWire, hardWire })}`);
  return ok;
}

function main() {
  if (process.argv.includes('--self-test')) process.exit(selfTest() ? 0 : 1);

  // Never re-block a Stop that a previous block already continued.
  try {
    const payload = JSON.parse(readFileSync(0, 'utf8'));
    if (payload?.stop_hook_active) process.exit(0);
  } catch {
    /* no payload (manual run) — proceed */
  }

  const prs = ghJson('pr list --state open --json number,headRefName,baseRefName,body,isDraft --limit 50');
  const issues = ghJson('issue list --label loop-blocked --state open --json number,comments --limit 50');
  if (prs === null && issues === null) {
    // Fail open, but not mute. This branch fired for a completely different
    // reason during development — an undefined child-process import made every
    // query throw — and an exit-0-with-no-output hook is indistinguishable from
    // a repository with nothing to report.
    const unreachable = renderHookResult([], [
      'no GitHub data was reachable this stop (gh missing, unauthenticated, offline, or rate-limited) — EVERY write-back check was skipped',
    ]);
    if (unreachable.stdout) process.stdout.write(unreachable.stdout);
    process.exit(0);
  }

  const merged = ghJson('pr list --state merged --json number,headRefName,body --limit 20');
  const openIssues = ghJson('issue list --state open --json number,labels,body --limit 100');

  const { hard, reminders } = checkPrs(prs);
  hard.push(...checkUnpushedLoopWork(prs, unpushedCommitCount));
  if (merged !== null && openIssues !== null) {
    reminders.push(...checkMergedClosedGap(merged, openIssues.map((issue) => issue.number)));
  }
  if (openIssues !== null) {
    reminders.push(...checkStrandedStepLabels(openIssues));
    hard.push(...checkStepLabelDrift(prs, openIssues, pushedCommitCount));
    // Only with BOTH lists on the wire: without the PRs, a claimed unit reads as
    // eligible and the gap would argue with a run that is mid-flight.
    if (prs !== null) hard.push(...checkDarkRun(loopRunIsLive(ROOT), openIssues, prs));
  }
  reminders.push(...checkSkippedQueries({
    openPrs: prs !== null,
    blockedIssues: issues !== null,
    mergedPrs: merged !== null,
    openIssues: openIssues !== null,
  }));
  const blockedGaps = checkBlockedIssues(issues);
  const allHard = [...hard, ...blockedGaps];
  const result = renderHookResult(allHard, reminders);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
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
