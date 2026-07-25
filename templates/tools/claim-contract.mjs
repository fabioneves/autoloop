#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const LOOP_BRANCH_RE = /^(?:feat|fix|chore|docs|refactor|test|perf|build|ci)\/gh-(?<issue>[1-9]\d*)-(?<slug>[a-z0-9]+(?:-[a-z0-9]+)*)$/;
export const CLOSES_RE = /\b(?<keyword>close(?:s|d)?|fix(?:es|ed)?|resolve(?:s|d)?)(?<colon>:?)\s+#(?<issue>[1-9]\d*)\b/i;
export const CLAIM_CONTRACT_FIXTURES = [
  { name: 'canonical close', branch: 'feat/gh-12-add-thing', body: 'Closes #12', valid: true, issue: 12, normalizedClosing: 'Closes #12' },
  { name: 'colon close', branch: 'fix/gh-5-guard', body: 'Closes: #5', valid: true, issue: 5, normalizedClosing: 'Closes #5' },
  { name: 'fixed keyword', branch: 'fix/gh-7-guard', body: 'FIXED #7', valid: true, issue: 7, normalizedClosing: 'Closes #7' },
  { name: 'resolved keyword', branch: 'docs/gh-9-guide', body: 'resolved: #9', valid: true, issue: 9, normalizedClosing: 'Closes #9' },
  { name: 'numeric slug segment', branch: 'build/gh-12-api-v2', body: 'Closes #12', valid: true, issue: 12, normalizedClosing: 'Closes #12' },
  { name: 'issue mismatch', branch: 'feat/gh-12-add-thing', body: 'Closes #13', valid: false, issue: null, normalizedClosing: 'Closes #13' },
  { name: 'missing branch claim', branch: 'feature/gh-12-add-thing', body: 'Closes #12', valid: false, issue: null, normalizedClosing: 'Closes #12' },
  { name: 'zero branch issue rejected', branch: 'feat/gh-0-thing', body: 'Closes #1', valid: false, issue: null, normalizedClosing: 'Closes #1' },
  { name: 'leading-zero branch issue rejected', branch: 'feat/gh-01-thing', body: 'Closes #1', valid: false, issue: null, normalizedClosing: 'Closes #1' },
  { name: 'empty branch slug rejected', branch: 'feat/gh-12-', body: 'Closes #12', valid: false, issue: null, normalizedClosing: 'Closes #12' },
  { name: 'uppercase branch slug rejected', branch: 'feat/gh-12-Thing', body: 'Closes #12', valid: false, issue: null, normalizedClosing: 'Closes #12' },
  { name: 'unsafe branch slug rejected', branch: 'feat/gh-12-add_thing', body: 'Closes #12', valid: false, issue: null, normalizedClosing: 'Closes #12' },
  { name: 'nested branch slug rejected', branch: 'feat/gh-12-add/thing', body: 'Closes #12', valid: false, issue: null, normalizedClosing: 'Closes #12' },
  { name: 'empty slug segment rejected', branch: 'feat/gh-12-add--thing', body: 'Closes #12', valid: false, issue: null, normalizedClosing: 'Closes #12' },
  { name: 'trailing slug separator rejected', branch: 'feat/gh-12-add-thing-', body: 'Closes #12', valid: false, issue: null, normalizedClosing: 'Closes #12' },
  { name: 'missing body claim', branch: 'feat/gh-12-add-thing', body: 'See #12', valid: false, issue: null, normalizedClosing: null },
  { name: 'space before colon rejected', branch: 'feat/gh-12-add-thing', body: 'Closes : #12', valid: false, issue: null, normalizedClosing: null },
  { name: 'no space after colon rejected', branch: 'feat/gh-12-add-thing', body: 'Closes:#12', valid: false, issue: null, normalizedClosing: null },
  { name: 'multiple body issues rejected', branch: 'feat/gh-12-add-thing', body: 'Closes #12\nFixes #13', valid: false, issue: null, normalizedClosing: null },
];

function issueNumber(value) {
  const issue = Number(value);
  return Number.isSafeInteger(issue) && issue > 0 ? issue : null;
}

export function parseLoopBranchIssue(branch) {
  if (typeof branch !== 'string') return null;
  return issueNumber(LOOP_BRANCH_RE.exec(branch)?.groups?.issue);
}

export function parseLoopClaim(input = {}) {
  const claim = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const branch = typeof claim.branch === 'string' ? claim.branch : '';
  const body = typeof claim.body === 'string' ? claim.body : '';
  const bodyMatches = [...body.matchAll(new RegExp(CLOSES_RE.source, 'gi'))];
  const branchIssue = parseLoopBranchIssue(branch);
  const bodyIssues = [...new Set(bodyMatches.map((match) => issueNumber(match.groups?.issue)).filter(Boolean))];
  const bodyIssue = bodyIssues.length === 1 ? bodyIssues[0] : null;
  const issuesEqual = branchIssue !== null && bodyIssue !== null ? branchIssue === bodyIssue : null;
  const valid = bodyIssues.length === 1 && issuesEqual === true;
  const reasonCode =
    branchIssue === null
      ? 'BRANCH_CLAIM_MISSING'
      : bodyMatches.length === 0
        ? 'BODY_CLAIM_MISSING'
        : bodyIssues.length !== 1
          ? 'BODY_CLAIM_AMBIGUOUS'
          : issuesEqual
            ? 'CLAIM_VALID'
            : 'ISSUE_MISMATCH';
  return {
    kind: 'loop-claim',
    version: 1,
    valid,
    branchIssue,
    bodyIssue,
    issuesEqual,
    issue: valid ? branchIssue : null,
    normalizedClosing: bodyIssue === null ? null : `Closes #${bodyIssue}`,
    reasonCode,
  };
}

function selfTest() {
  const failures = [];
  for (const fixture of CLAIM_CONTRACT_FIXTURES) {
    const result = parseLoopClaim(fixture);
    if (
      result.valid !== fixture.valid ||
      result.issue !== fixture.issue ||
      result.normalizedClosing !== fixture.normalizedClosing
    ) {
      failures.push(fixture.name);
    }
  }
  const mismatch = parseLoopClaim({ branch: 'feat/gh-12-x', body: 'Closes #13' });
  if (mismatch.branchIssue !== 12 || mismatch.bodyIssue !== 13 || mismatch.issuesEqual !== false) {
    failures.push('typed mismatch decision');
  }
  for (const name of failures) console.error(`FAIL: ${name}`);
  console.log(failures.length ? `self-test: ${failures.length} FAILED` : `self-test OK (${CLAIM_CONTRACT_FIXTURES.length + 1} checks)`);
  return failures.length === 0;
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMain) process.exit(selfTest() ? 0 : 1);
