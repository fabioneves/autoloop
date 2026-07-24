#!/usr/bin/env node
// SHA-bound verdict publisher. Posts gate/review CheckRuns through the caller's
// GitHub App identity so the merge gate can authenticate both the head and producer.
//
// Deliberately narrow:
//   - closed name enum: agentic/gate, agentic/review
//   - only `success` can be posted — absence is the failure signal; a red gate/review
//     is never published
//   - details arrive through a file, never shell arguments
//
// Usage: node tools/agentic/publish-verdict.mjs <gate|review> <40-hex sha>
//        [--summary-file <path>] [--expect-app-id <positive integer>]

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CONTEXTS = new Set(['gate', 'review']);
const SHA_RE = /^[0-9a-f]{40}$/;

export function buildCheckRun(ctx, sha, summary) {
  const text = typeof summary === 'string' && summary.length > 0
    ? summary.slice(0, 65535)
    : 'Verified by the Autoloop development workflow.';
  return {
    name: `agentic/${ctx}`,
    head_sha: sha,
    status: 'completed',
    conclusion: 'success',
    output: {
      title: `Autoloop ${ctx} passed`,
      summary: text,
    },
  };
}

export function hasTrustedProducer(checkRun, trustedAppIds) {
  return (
    Array.isArray(trustedAppIds)
    && trustedAppIds.some((id) => Number.isInteger(id) && id > 0 && id === checkRun?.app?.id)
  );
}

// Pure arg validation — closed context enum + lowercase 40-hex SHA. Exported for --self-test.
export function validateArgs(ctx, sha) {
  if (!CONTEXTS.has(ctx)) return { ok: false, error: `context must be one of: ${[...CONTEXTS].join(', ')}` };
  if (!SHA_RE.test(sha ?? '')) return { ok: false, error: 'second arg must be the full 40-hex (lowercase) gated SHA (git rev-parse HEAD)' };
  return { ok: true };
}

export function parseArgs(args) {
  const [ctx, sha, ...rest] = args;
  const parsed = {
    ctx,
    sha,
    summaryFile: null,
    expectedAppId: null,
    selfTest: args.length === 1 && args[0] === '--self-test',
    error: null,
  };
  if (parsed.selfTest) return parsed;
  const valid = validateArgs(ctx, sha);
  if (!valid.ok) {
    parsed.error = valid.error;
    return parsed;
  }
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (flag === '--summary-file' && parsed.summaryFile === null && value && !value.startsWith('-')) {
      parsed.summaryFile = value;
      index += 1;
      continue;
    }
    if (flag === '--expect-app-id' && parsed.expectedAppId === null && /^\d+$/.test(value ?? '')) {
      parsed.expectedAppId = Number(value);
      if (!Number.isSafeInteger(parsed.expectedAppId) || parsed.expectedAppId < 1) {
        parsed.error = '--expect-app-id must be a positive safe integer';
        return parsed;
      }
      index += 1;
      continue;
    }
    parsed.error = `unknown, duplicate, or incomplete option: ${flag ?? 'missing'}`;
    return parsed;
  }
  return parsed;
}

function selfTest() {
  const cases = [
    [['gate', 'a'.repeat(40)], true],
    [['review', 'a'.repeat(40)], true],
    [['deploy', 'a'.repeat(40)], false], // context outside the closed enum
    [[undefined, 'a'.repeat(40)], false],
    [['gate', 'a'.repeat(39)], false], // too short
    [['gate', 'a'.repeat(41)], false], // too long
    [['gate', 'A'.repeat(40)], false], // uppercase rejected — git SHAs are lowercase
    [['gate', 'g'.repeat(40)], false], // non-hex
    [['gate', undefined], false],
  ];
  let passed = 0;
  for (const [[ctx, sha], expect] of cases) {
    if (validateArgs(ctx, sha).ok === expect) {
      passed += 1;
    } else {
      console.error(`FAIL [expect ${expect}]: ctx=${ctx} sha=${String(sha).slice(0, 8)}`);
    }
  }
  const payload = buildCheckRun('gate', 'a'.repeat(40), 'gate passed');
  if (
    payload.name !== 'agentic/gate'
    || payload.head_sha !== 'a'.repeat(40)
    || payload.status !== 'completed'
    || payload.conclusion !== 'success'
  ) {
    console.error('FAIL verdict publishes as a completed CheckRun');
  } else passed += 1;
  if (hasTrustedProducer({ app: { id: 42, slug: 'autoloop-verdicts' } }, [42])) {
    passed += 1;
  } else {
    console.error('FAIL configured GitHub App producer is accepted');
  }
  if (!hasTrustedProducer({ app: { id: 7, slug: 'unknown' } }, [42])) {
    passed += 1;
  } else {
    console.error('FAIL unconfigured producer is rejected');
  }
  const parsed = parseArgs([
    'review',
    'a'.repeat(40),
    '--summary-file',
    '/tmp/review.json',
    '--expect-app-id',
    '42',
  ]);
  if (!parsed.error && parsed.summaryFile === '/tmp/review.json' && parsed.expectedAppId === 42) {
    passed += 1;
  } else {
    console.error('FAIL closed CLI options parse');
  }
  const inline = parseArgs(['gate', 'a'.repeat(40), 'untrusted inline summary']);
  if (inline.error) passed += 1;
  else console.error('FAIL inline summary is rejected');
  const total = cases.length + 5;
  console.log(passed === total ? `self-test OK (${passed} cases)` : `self-test FAILED (${passed}/${total})`);
  return passed === total;
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.selfTest) process.exit(selfTest() ? 0 : 1);
  if (parsed.error) {
    console.error(`publish-verdict: ${parsed.error}`);
    process.exit(2);
  }
  let summary;
  try {
    summary = parsed.summaryFile === null ? undefined : readFileSync(parsed.summaryFile, 'utf8');
  } catch (error) {
    console.error(`publish-verdict: summary file could not be read: ${error.message}`);
    process.exit(1);
  }
  const payload = buildCheckRun(parsed.ctx, parsed.sha, summary);
  try {
    const output = execFileSync(
      'gh',
      [
        'api',
        'repos/{owner}/{repo}/check-runs',
        '--method',
        'POST',
        '--input',
        '-',
      ],
      {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 15000,
      },
    );
    const checkRun = JSON.parse(output);
    if (
      checkRun.name !== payload.name
      || checkRun.head_sha !== parsed.sha
      || checkRun.status !== 'completed'
      || checkRun.conclusion !== 'success'
    ) {
      throw new Error('GitHub returned a mismatched CheckRun');
    }
    if (
      parsed.expectedAppId !== null
      && !hasTrustedProducer(checkRun, [parsed.expectedAppId])
    ) {
      throw new Error(`CheckRun producer app ${checkRun.app?.id ?? 'unknown'} is not expected app ${parsed.expectedAppId}`);
    }
    console.log(
      `posted ${payload.name}=success on ${parsed.sha.slice(0, 12)} via app ${checkRun.app?.id ?? 'unknown'}`,
    );
  } catch (error) {
    console.error(`publish-verdict: gh api failed: ${error.message}`);
    process.exit(1);
  }
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
