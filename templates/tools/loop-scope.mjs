#!/usr/bin/env node
// Loop-ownership predicate for the autoloop:pitcrew.
//
// The pitcrew must only ever act on the LOOP's OWN PRs — never a human's branch
// (it rebases and --force-with-lease pushes; misclassification is destructive).
// "Loop-owned" is two signals, BOTH required: a head branch matching the autoloop:dev
// claim convention <type>/gh-<N>-<slug>, AND a body that `Closes #N`. A loop branch
// that forgot its claim is a bug the pitcrew should NOT auto-act on.
//
// Usage:
//   node tools/agentic/loop-scope.mjs <prNumber>      # exit 0 = loop-owned, 1 = not
//   node tools/agentic/loop-scope.mjs --check-branch <branch> --body-file <path>
//   node tools/agentic/loop-scope.mjs --self-test

import { execSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Types exactly as autoloop:dev step 4 enumerates them.
export const LOOP_BRANCH_RE = /^(feat|fix|chore|docs|refactor|test|perf|build|ci)\/gh-\d+-/;
// Closing keyword (optional colon) + `#N`. KEEP IN SYNC with scan.mjs's CLOSES_RE.
export const CLOSES_RE = /\b(clos(e|es|ed)|fix(es|ed)?|resolv(e|es|ed)):?\s+#\d+/i;

export function inScope({ branch, body }) {
  if (!LOOP_BRANCH_RE.test(branch ?? '')) {
    return { inScope: false, reason: `branch "${branch}" is not a loop branch (<type>/gh-<N>-…)` };
  }
  if (!CLOSES_RE.test(body ?? '')) {
    return { inScope: false, reason: 'PR body does not claim an issue (no "Closes #N")' };
  }
  return { inScope: true, reason: 'loop-owned (branch convention + Closes #N)' };
}

function selfTest() {
  const cases = [
    [{ branch: 'feat/gh-12-add-thing', body: 'Closes #12' }, true],
    [{ branch: 'fix/gh-3-null-guard', body: 'Fixes #3\n\ndetails' }, true],
    [{ branch: 'feat/gh-5-colon', body: 'Closes: #5' }, true], // GitHub's colon form links too
    [{ branch: 'feat/gh-12-add-thing', body: 'no claim here' }, false],
    [{ branch: 'feature/gh-12-x', body: 'Closes #12' }, false], // "feature" is not our type list
    [{ branch: 'hardening/deployment-operations', body: 'Closes #9' }, false],
    [{ branch: 'develop', body: 'Closes #1' }, false],
    [{ branch: '', body: '' }, false],
  ];
  let ok = true;
  for (const [pr, expect] of cases) {
    const got = inScope(pr).inScope;
    if (got !== expect) {
      console.error(`FAIL [expect ${expect}, got ${got}]: ${JSON.stringify(pr)}`);
      ok = false;
    }
  }
  console.log(ok ? `self-test OK (${cases.length} cases)` : 'self-test FAILED');
  return ok;
}

function fromArgs(args) {
  const bi = args.indexOf('--check-branch');
  const fi = args.indexOf('--body-file');
  if (bi !== -1) {
    return { branch: args[bi + 1], body: fi !== -1 ? readFileSync(args[fi + 1], 'utf8') : '' };
  }
  const number = args.find((a) => /^\d+$/.test(a));
  if (!number) return null;
  const { headRefName, body } = JSON.parse(
    execSync(`gh pr view ${number} --json headRefName,body`, { encoding: 'utf8' }),
  );
  return { branch: headRefName, body };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  const pr = fromArgs(args);
  if (!pr) {
    console.error('usage: loop-scope.mjs <prNumber> | --check-branch <branch> [--body-file <path>] | --self-test');
    process.exit(2);
  }
  const { inScope: ok, reason } = inScope(pr);
  console.log(`${ok ? 'IN-SCOPE' : 'OUT-OF-SCOPE'}: ${reason}`);
  process.exit(ok ? 0 : 1);
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
