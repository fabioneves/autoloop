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

import { execSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { LOOP_BRANCH_RE, parseLoopClaim } from './claim-contract.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function ghJson(cmd) {
  try {
    const out = execSync(`gh ${cmd}`, {
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

/** Local-only: commits on the branch that the remote tracking ref does not have. */
function unpushedCommitCount(branch) {
  try {
    const range = `refs/remotes/origin/${branch}..refs/heads/${branch}`;
    const out = execSync(`git rev-list --count ${JSON.stringify(range)}`, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15000,
    });
    const count = Number(String(out).trim());
    return Number.isSafeInteger(count) ? count : null;
  } catch {
    return null; // unknown branch, no remote ref, or no git — never guess
  }
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
  const stranded = checkStrandedStepLabels([
    { number: 7, labels: [{ name: 'loop-ready' }, { name: 'loop-delivered' }, { name: 'loop:04-claim' }, { name: 'loop:07-diff-review' }] },
    { number: 8, labels: [{ name: 'loop-delivered' }] },
    { number: 9, labels: [{ name: 'loop:05-implement' }, { name: 'loop-started' }] },
  ]);
  const reminderWire = renderHookResult([], reminders);
  const hardWire = renderHookResult([...hard, ...blocked], reminders);
  let reminderJson;
  try {
    reminderJson = JSON.parse(reminderWire.stdout);
  } catch {
    reminderJson = null;
  }
  const ok =
    hard.length === 2 && hard[0].includes('#2') && hard[1].includes('#6') &&
    reminders.length === 1 && reminders[0].includes('#3') &&
    mergedGap.length === 2 && mergedGap[0].includes('#7') && mergedGap[0].includes('PR #20') &&
    mergedGap[1].includes('PR #23') && mergedGap[1].includes('ISSUE_MISMATCH') &&
    blocked.length === 2 && blocked[0].includes('#9') && blocked[1].includes('#12') &&
    // Only the loop-branch PR with local-only commits: a pushed loop branch is
    // silent, a non-loop branch is never this hook's business, and an
    // unanswerable ref comparison is skipped rather than guessed at.
    unpushed.length === 1 && unpushed[0].includes('#3') && unpushed[0].includes('4') &&
    stranded.length === 1 && stranded[0].includes('#7') && stranded[0].includes('loop:04-claim') &&
    stranded[0].includes('--remove-label loop:07-diff-review') &&
    reminderWire.exitCode === 0 && reminderWire.stderr === '' &&
    Object.keys(reminderJson ?? {}).length === 1 &&
    reminderJson?.systemMessage?.includes('writeback reminder: PR #3') &&
    hardWire.exitCode === 2 && hardWire.stdout === '' &&
    hardWire.stderr.includes('Write-back contract gaps') &&
    hardWire.stderr.includes('PR #3') &&
    renderHookResult(['gap'], []).stderr.includes('reminders') === false;
  console.log(ok ? 'self-test OK' : `self-test FAILED: ${JSON.stringify({ hard, reminders, blocked, reminderWire, hardWire })}`);
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

  const prs = ghJson('pr list --state open --json number,headRefName,body,isDraft --limit 50');
  const issues = ghJson('issue list --label loop-blocked --state open --json number,comments --limit 50');
  if (prs === null && issues === null) process.exit(0); // gh unavailable — fail open

  const merged = ghJson('pr list --state merged --json number,headRefName,body --limit 20');
  const openIssues = ghJson('issue list --state open --json number,labels --limit 100');

  const { hard, reminders } = checkPrs(prs);
  hard.push(...checkUnpushedLoopWork(prs, unpushedCommitCount));
  if (merged !== null && openIssues !== null) {
    reminders.push(...checkMergedClosedGap(merged, openIssues.map((issue) => issue.number)));
  }
  if (openIssues !== null) reminders.push(...checkStrandedStepLabels(openIssues));
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
