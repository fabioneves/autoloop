#!/usr/bin/env node
// SHA-bound verdict publisher. Posts the loop's
// gate/review verdicts as GitHub commit statuses so the human merging sees, ON the merge
// page, that the head they merge is the exact SHA the loop gated and the reviewer reviewed — any
// later push silently invalidates the verdict (statuses are SHA-bound).
//
// Deliberately narrow:
//   - closed context enum: agentic/gate, agentic/review
//   - only `success` can be posted — absence is the failure signal; a red gate/review
//     is never published (and NEVER post a status for a pass that didn't happen)
//   - with the shared maintainer login this is evidence, not proof: real integrity
//     arrives with the dedicated machine identity (STATE.md → L2, post-MVP)
//
// Usage: node tools/agentic/publish-verdict.mjs <gate|review> <40-hex sha> [description]

import { execSync } from 'node:child_process';

const CONTEXTS = new Set(['gate', 'review']);
const SHA_RE = /^[0-9a-f]{40}$/;

// Pure arg validation — closed context enum + lowercase 40-hex SHA. Exported for --self-test.
export function validateArgs(ctx, sha) {
  if (!CONTEXTS.has(ctx)) return { ok: false, error: `context must be one of: ${[...CONTEXTS].join(', ')}` };
  if (!SHA_RE.test(sha ?? '')) return { ok: false, error: 'second arg must be the full 40-hex (lowercase) gated SHA (git rev-parse HEAD)' };
  return { ok: true };
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
  let ok = true;
  for (const [[ctx, sha], expect] of cases) {
    if (validateArgs(ctx, sha).ok !== expect) {
      console.error(`FAIL [expect ${expect}]: ctx=${ctx} sha=${String(sha).slice(0, 8)}`);
      ok = false;
    }
  }
  console.log(ok ? `self-test OK (${cases.length} cases)` : 'self-test FAILED');
  return ok;
}

function main() {
  if (process.argv.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  const [ctx, sha, ...desc] = process.argv.slice(2);
  const valid = validateArgs(ctx, sha);
  if (!valid.ok) {
    console.error(`publish-verdict: ${valid.error}`);
    process.exit(2);
  }
  const description = (desc.join(' ') || 'verified by the dev loop').slice(0, 140);
  try {
    execSync(
      `gh api repos/{owner}/{repo}/statuses/${sha} ` +
        `-f state=success -f context=agentic/${ctx} -f description=${JSON.stringify(description)}`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000 },
    );
    console.log(`posted agentic/${ctx}=success on ${sha.slice(0, 12)}`);
  } catch (e) {
    console.error(`publish-verdict: gh api failed: ${e.message}`);
    process.exit(1);
  }
}

main();
