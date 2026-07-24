#!/usr/bin/env node

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SHA_RE = /^[0-9a-f]{40}$/i;
const GREEN_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

function result(state, code, detail = {}) {
  return {
    state,
    code,
    canMarkDelivered: state === 'delivered',
    ...detail,
  };
}

function classifyCheck(check) {
  const state = String(check?.state ?? '').toUpperCase();
  if (state) {
    if (state === 'SUCCESS') return 'green';
    if (state === 'PENDING' || state === 'EXPECTED') return 'pending';
    return 'failed';
  }
  const status = String(check?.status ?? '').toUpperCase();
  const conclusion = String(check?.conclusion ?? '').toUpperCase();
  if (status && status !== 'COMPLETED') return 'pending';
  if (!conclusion) return 'pending';
  return GREEN_CONCLUSIONS.has(conclusion) ? 'green' : 'failed';
}

export function finalizeHead(input) {
  const headFields = [
    'committedHead',
    'reviewedHead',
    'gatedHead',
    'remoteHead',
  ];
  if (
    !input
    || headFields.some((field) => !SHA_RE.test(input[field] ?? ''))
  ) {
    return result('error', 'INVALID_DELIVERY_INPUT');
  }
  if (input.committedHead !== input.reviewedHead) {
    return result('re-review', 'REVIEW_HEAD_MISMATCH', {
      committedHead: input.committedHead,
      reviewedHead: input.reviewedHead,
    });
  }
  if (input.reviewedHead !== input.gatedHead) {
    return result('re-gate', 'GATE_HEAD_MISMATCH', {
      reviewedHead: input.reviewedHead,
      gatedHead: input.gatedHead,
    });
  }
  if (input.gatedHead !== input.remoteHead) {
    return result('re-gate', 'REMOTE_HEAD_MISMATCH', {
      gatedHead: input.gatedHead,
      remoteHead: input.remoteHead,
    });
  }
  if (
    !input.ci
    || input.ci.complete !== true
    || input.ci.requirementsComplete !== true
    || !Array.isArray(input.ci.requiredChecks)
    || input.ci.requiredChecks.some((name) =>
      typeof name !== 'string' || name.length === 0)
    || new Set(input.ci.requiredChecks).size !== input.ci.requiredChecks.length
    || !Array.isArray(input.ci.checks)
  ) {
    return result('awaiting-ci', 'CI_EVIDENCE_INCOMPLETE', { headOid: input.remoteHead });
  }
  if (input.ci.headOid !== input.remoteHead) {
    return result('awaiting-ci', 'CI_EVIDENCE_HEAD_MISMATCH', { headOid: input.remoteHead });
  }

  let pending = false;
  const failedChecks = [];
  const observedChecks = new Set();
  for (const check of input.ci.checks) {
    if (check?.headOid && check.headOid !== input.remoteHead) {
      pending = true;
      continue;
    }
    const name = String(check?.name ?? check?.context ?? '');
    if (name) observedChecks.add(name);
    const classification = classifyCheck(check);
    if (classification === 'pending') pending = true;
    if (classification === 'failed') failedChecks.push(name || 'unknown');
  }
  const missingChecks = input.ci.requiredChecks
    .filter((name) => !observedChecks.has(name));
  if (failedChecks.length > 0) {
    return result('gate-red', 'CI_FAILED', {
      headOid: input.remoteHead,
      failedChecks,
    });
  }
  if (missingChecks.length > 0) {
    return result('awaiting-ci', 'CI_REQUIRED_CHECK_MISSING', {
      headOid: input.remoteHead,
      missingChecks,
    });
  }
  if (pending) return result('awaiting-ci', 'CI_PENDING', { headOid: input.remoteHead });
  return result('delivered', input.ci.requiredChecks.length === 0 ? 'NO_REQUIRED_CI' : 'CI_GREEN', {
    headOid: input.remoteHead,
  });
}

function selfTest() {
  const sha = 'a'.repeat(40);
  const other = 'b'.repeat(40);
  const cases = [
    {
      name: 'explicit complete no-required-CI policy is delivered',
      input: {
        committedHead: sha,
        reviewedHead: sha,
        gatedHead: sha,
        remoteHead: sha,
        ci: {
          complete: true,
          requirementsComplete: true,
          requiredChecks: [],
          headOid: sha,
          checks: [],
        },
      },
      expected: 'delivered',
    },
    {
      name: 'pending check produces awaiting-ci',
      input: {
        committedHead: sha,
        reviewedHead: sha,
        gatedHead: sha,
        remoteHead: sha,
        ci: {
          complete: true,
          requirementsComplete: true,
          requiredChecks: ['test'],
          headOid: sha,
          checks: [{ name: 'test', status: 'IN_PROGRESS', conclusion: null, headOid: sha }],
        },
      },
      expected: 'awaiting-ci',
    },
    {
      name: 'incomplete check snapshot cannot prove delivery',
      input: {
        committedHead: sha,
        reviewedHead: sha,
        gatedHead: sha,
        remoteHead: sha,
        ci: {
          complete: false,
          requirementsComplete: true,
          requiredChecks: [],
          checks: [],
        },
      },
      expected: 'awaiting-ci',
    },
    {
      name: 'empty fetched checks without complete requirements cannot prove no CI',
      input: {
        committedHead: sha,
        reviewedHead: sha,
        gatedHead: sha,
        remoteHead: sha,
        ci: { complete: true, headOid: sha, checks: [] },
      },
      expected: 'awaiting-ci',
    },
    {
      name: 'missing required check remains awaiting CI',
      input: {
        committedHead: sha,
        reviewedHead: sha,
        gatedHead: sha,
        remoteHead: sha,
        ci: {
          complete: true,
          requirementsComplete: true,
          requiredChecks: ['test'],
          headOid: sha,
          checks: [],
        },
      },
      expected: 'awaiting-ci',
    },
    {
      name: 'failed check returns gate-red',
      input: {
        committedHead: sha,
        reviewedHead: sha,
        gatedHead: sha,
        remoteHead: sha,
        ci: {
          complete: true,
          requirementsComplete: true,
          requiredChecks: ['test'],
          headOid: sha,
          checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', headOid: sha }],
        },
      },
      expected: 'gate-red',
    },
    {
      name: 'stale green check cannot prove delivery',
      input: {
        committedHead: sha,
        reviewedHead: sha,
        gatedHead: sha,
        remoteHead: sha,
        ci: {
          complete: true,
          requirementsComplete: true,
          requiredChecks: ['test'],
          headOid: sha,
          checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', headOid: other }],
        },
      },
      expected: 'awaiting-ci',
    },
    {
      name: 'remote head mismatch requires re-gate',
      input: {
        committedHead: sha,
        reviewedHead: sha,
        gatedHead: sha,
        remoteHead: other,
        ci: {
          complete: true,
          requirementsComplete: true,
          requiredChecks: [],
          headOid: other,
          checks: [],
        },
      },
      expected: 're-gate',
    },
    {
      name: 'unreviewed committed head requires another review',
      input: {
        committedHead: other,
        reviewedHead: sha,
        gatedHead: sha,
        remoteHead: sha,
        ci: {
          complete: true,
          requirementsComplete: true,
          requiredChecks: [],
          headOid: sha,
          checks: [],
        },
      },
      expected: 're-review',
    },
    {
      name: 'ungated reviewed head requires another gate',
      input: {
        committedHead: other,
        reviewedHead: other,
        gatedHead: sha,
        remoteHead: sha,
        ci: {
          complete: true,
          requirementsComplete: true,
          requiredChecks: [],
          headOid: sha,
          checks: [],
        },
      },
      expected: 're-gate',
    },
  ];
  let passed = 0;
  for (const fixture of cases) {
    const actual = finalizeHead(fixture.input);
    if (actual.state !== fixture.expected) {
      console.error(`FAIL ${fixture.name}: expected ${fixture.expected}, got ${actual.state}`);
      continue;
    }
    passed += 1;
  }
  console.log(passed === cases.length ? `self-test OK (${passed} cases)` : `self-test FAILED (${passed}/${cases.length})`);
  return passed === cases.length;
}

function main() {
  if (process.argv.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  const input = JSON.parse(readFileSync(0, 'utf8'));
  process.stdout.write(`${JSON.stringify(finalizeHead(input))}\n`);
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMain) main();
