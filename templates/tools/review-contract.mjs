#!/usr/bin/env node

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const GATING_SEVERITIES = new Set(['critical', 'major']);

function decision(state, code, detail = {}) {
  return {
    state,
    code,
    publishReviewSuccess: state === 'clean',
    ...detail,
  };
}

export function reviewTransition(input) {
  if (
    !input ||
    !Number.isInteger(input.round) ||
    !Number.isInteger(input.cap) ||
    input.round < 1 ||
    input.cap < 1 ||
    input.round > input.cap ||
    !new Set(['full', 'delta']).has(input.scope) ||
    !Array.isArray(input.findings) ||
    !Array.isArray(input.rebuts)
  ) {
    return decision('error', 'INVALID_REVIEW_INPUT');
  }

  const gating = input.findings.filter((finding) =>
    GATING_SEVERITIES.has(String(finding?.severity ?? '').toLowerCase()),
  );
  if (gating.some((finding) => finding.verified !== true)) {
    return decision('verify', 'FINDING_VERIFICATION_REQUIRED');
  }
  const late = input.scope === 'delta'
    ? gating.filter((finding) => finding.inScope !== true)
    : [];
  if (late.length > 0) {
    return decision('human-block', 'VERIFIED_OUT_OF_DELTA_FINDING', {
      findings: late.map(({ severity }) => severity),
    });
  }

  const unresolvedFindings = gating.filter(
    (finding) => finding.disposition !== 'accepted-rebut',
  );
  const unresolvedRebuts = input.rebuts.filter((rebut) => rebut?.status !== 'accepted');
  if (unresolvedFindings.length === 0 && unresolvedRebuts.length === 0) {
    return decision('clean', 'REVIEW_CLEAN');
  }
  if (input.round >= input.cap) {
    return decision('human-block', 'REVIEW_CAP_REACHED', {
      unresolvedFindings: unresolvedFindings.length,
      unresolvedRebuts: unresolvedRebuts.length,
    });
  }
  return decision('continue', 'REVIEW_FIX_DELTA_REQUIRED', {
    unresolvedFindings: unresolvedFindings.length,
    unresolvedRebuts: unresolvedRebuts.length,
  });
}

function selfTest() {
  const cases = [
    {
      name: 'clean full review publishes success',
      input: { round: 1, cap: 3, scope: 'full', findings: [], rebuts: [] },
      expected: ['clean', true],
    },
    {
      name: 'verified late Major blocks for a human',
      input: {
        round: 2,
        cap: 3,
        scope: 'delta',
        findings: [{ severity: 'Major', verified: true, inScope: false, disposition: 'unresolved' }],
        rebuts: [],
      },
      expected: ['human-block', false],
    },
    {
      name: 'verified late Critical blocks even before cap',
      input: {
        round: 2,
        cap: 4,
        scope: 'delta',
        findings: [{ severity: 'Critical', verified: true, inScope: false, disposition: 'unresolved' }],
        rebuts: [],
      },
      expected: ['human-block', false],
    },
    {
      name: 'in-scope Major continues below cap',
      input: {
        round: 2,
        cap: 3,
        scope: 'delta',
        findings: [{ severity: 'Major', verified: true, inScope: true, disposition: 'fix' }],
        rebuts: [],
      },
      expected: ['continue', false],
    },
    {
      name: 'unresolved Major at cap blocks',
      input: {
        round: 3,
        cap: 3,
        scope: 'delta',
        findings: [{ severity: 'Major', verified: true, inScope: true, disposition: 'unresolved' }],
        rebuts: [],
      },
      expected: ['human-block', false],
    },
    {
      name: 'accepted rebut permits clean result',
      input: {
        round: 2,
        cap: 3,
        scope: 'delta',
        findings: [],
        rebuts: [{ status: 'accepted' }],
      },
      expected: ['clean', true],
    },
    {
      name: 'open rebut continues below cap',
      input: {
        round: 2,
        cap: 3,
        scope: 'delta',
        findings: [],
        rebuts: [{ status: 'open' }],
      },
      expected: ['continue', false],
    },
  ];
  let passed = 0;
  for (const fixture of cases) {
    const actual = reviewTransition(fixture.input);
    if (actual.state !== fixture.expected[0] || actual.publishReviewSuccess !== fixture.expected[1]) {
      console.error(
        `FAIL ${fixture.name}: expected ${fixture.expected.join('/')}, got ${actual.state}/${actual.publishReviewSuccess}`,
      );
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
  process.stdout.write(`${JSON.stringify(reviewTransition(input))}\n`);
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
