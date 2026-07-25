#!/usr/bin/env node
// Loop-ownership predicate for the autoloop:pitcrew.
//
// The pitcrew must only ever act on the LOOP's OWN PRs — never a human's branch
// (it rebases and --force-with-lease pushes; misclassification is destructive).
// "Loop-owned" requires a same-repository head plus a head branch matching the
// autoloop:dev claim convention <type>/gh-<N>-<slug> and a body that `Closes #N`.
// A loop branch that forgot its claim is a bug the pitcrew should NOT auto-act on.
//
// Usage:
//   node tools/agentic/loop-scope.mjs <prNumber>      # exit 0 = loop-owned, 1 = not
//   node tools/agentic/loop-scope.mjs --check-branch <branch> --body-file <path>
//   node tools/agentic/loop-scope.mjs --self-test

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CLAIM_CONTRACT_FIXTURES,
  CLOSES_RE,
  LOOP_BRANCH_RE,
  parseLoopClaim,
} from './claim-contract.mjs';

export { CLOSES_RE, LOOP_BRANCH_RE };

export function inScope({ branch, body, repository, headRepository }) {
  if (
    typeof repository !== 'string'
    || repository.length === 0
    || typeof headRepository !== 'string'
    || headRepository.length === 0
  ) {
    return { inScope: false, reason: 'live base or PR head repository identity is unavailable' };
  }
  if (headRepository !== repository) {
    return {
      inScope: false,
      reason: `PR head repository "${headRepository}" is not the live repository "${repository}"`,
    };
  }
  const claim = parseLoopClaim({ branch, body });
  if (claim.reasonCode === 'BRANCH_CLAIM_MISSING') {
    return { inScope: false, reason: `branch "${branch}" is not a loop branch (<type>/gh-<N>-…)` };
  }
  if (claim.reasonCode === 'BODY_CLAIM_MISSING') {
    return { inScope: false, reason: 'PR body does not claim an issue (no "Closes #N")' };
  }
  if (claim.reasonCode === 'BODY_CLAIM_AMBIGUOUS') {
    return { inScope: false, reason: 'PR body claims more than one issue' };
  }
  if (claim.reasonCode === 'ISSUE_MISMATCH') {
    return {
      inScope: false,
      reason: `branch issue #${claim.branchIssue} does not match body issue #${claim.bodyIssue}`,
    };
  }
  return { inScope: true, reason: `loop-owned (branch convention + ${claim.normalizedClosing})` };
}

function selfTest() {
  const cases = [
    ...CLAIM_CONTRACT_FIXTURES.map((fixture) => [{
      ...fixture,
      repository: 'owner/repo',
      headRepository: 'owner/repo',
    }, fixture.valid]),
    [{
      branch: 'hardening/deployment-operations',
      body: 'Closes #9',
      repository: 'owner/repo',
      headRepository: 'owner/repo',
    }, false],
    [{
      branch: 'develop',
      body: 'Closes #1',
      repository: 'owner/repo',
      headRepository: 'owner/repo',
    }, false],
    [{
      branch: '',
      body: '',
      repository: 'owner/repo',
      headRepository: 'owner/repo',
    }, false],
    [{
      branch: 'feat/gh-7-fork',
      body: 'Closes #7',
      repository: 'owner/repo',
      headRepository: 'fork/repo',
    }, false],
    [{
      branch: 'feat/gh-7-missing-identity',
      body: 'Closes #7',
      repository: 'owner/repo',
      headRepository: null,
    }, false],
  ];
  let ok = true;
  for (const [pr, expect] of cases) {
    const got = inScope(pr).inScope;
    if (got !== expect) {
      console.error(`FAIL [expect ${expect}, got ${got}]: ${JSON.stringify(pr)}`);
      ok = false;
    }
  }
  const pinned = pullRequestViewArgs(7, 'owner/repo');
  if (
    pinned[pinned.indexOf('--repo') + 1] !== 'owner/repo'
    || pinned[pinned.indexOf('view') + 1] !== '7'
  ) {
    console.error('FAIL live PR fetch is not pinned to the captured repository');
    ok = false;
  }
  console.log(ok ? `self-test OK (${cases.length + 1} cases)` : 'self-test FAILED');
  return ok;
}

function ghJson(args) {
  return JSON.parse(execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
}

function pullRequestViewArgs(target, repository) {
  return [
    'pr',
    'view',
    String(target),
    '--repo',
    repository,
    '--json',
    'headRefName,body,headRepository',
  ];
}

function fromArgs(args) {
  const bi = args.indexOf('--check-branch');
  const fi = args.indexOf('--body-file');
  const number = bi === -1 ? args.find((a) => /^\d+$/.test(a)) : null;
  const branch = bi === -1 ? null : args[bi + 1];
  const target = number ?? branch;
  if (
    !target
    || (branch !== null && (
      typeof branch !== 'string'
      || branch.length === 0
      || branch.startsWith('-')
    ))
  ) {
    return null;
  }
  const repository = ghJson(['repo', 'view', '--json', 'nameWithOwner']).nameWithOwner;
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repository ?? '')) {
    throw new Error('live repository identity is invalid');
  }
  const pr = ghJson(pullRequestViewArgs(target, repository));
  const liveBody = typeof pr.body === 'string' ? pr.body : '';
  if (fi !== -1 && readFileSync(args[fi + 1], 'utf8') !== liveBody) {
    return {
      branch: pr.headRefName,
      body: liveBody,
      repository,
      headRepository: null,
    };
  }
  return {
    branch: pr.headRefName,
    body: liveBody,
    repository,
    headRepository: pr.headRepository?.nameWithOwner ?? null,
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  let pr;
  try {
    pr = fromArgs(args);
  } catch (error) {
    console.error(`OUT-OF-SCOPE: live repository evidence failed: ${error.message}`);
    process.exit(1);
  }
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
