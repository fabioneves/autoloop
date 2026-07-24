#!/usr/bin/env node

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SHA_RE = /^[0-9a-f]{40}$/i;
const HASH_RE = /^[0-9a-f]{64}$/i;
const BRANCH_RE = /^(feat|fix|chore|docs|refactor|test|perf|build|ci)\/gh-(\d+)-[a-z0-9-]+$/;
const PHASES = new Set([
  'intent-recorded',
  'local-claim',
  'remote-claim',
  'plan-comment',
  'draft-pr',
  'ready-head',
  'premerge-record',
  'merge-submitted',
  'terminal-record',
]);

function transition(state, action, code, detail = {}) {
  return { state, action, code, ...detail };
}

function validIntent(intentValue) {
  const branch = BRANCH_RE.exec(intentValue?.branch ?? '');
  return (
    Number.isInteger(intentValue?.issue) &&
    intentValue.issue > 0 &&
    Number(branch?.[2]) === intentValue.issue &&
    HASH_RE.test(intentValue.issueBodyHash ?? '') &&
    HASH_RE.test(intentValue.planHash ?? '') &&
    SHA_RE.test(intentValue.plannedBaseOid ?? '') &&
    new Set(['native', 'claude', 'codex', 'opencode']).has(intentValue.selector) &&
    HASH_RE.test(intentValue.runIntentHash ?? '') &&
    new Set(['invocation', 'relaunch', 'orphan-recovery']).has(intentValue.intentSource) &&
    new Set(['manual', 'ratified', 'auto']).has(intentValue.mergePolicy)
  );
}

function sameIdentity(intentValue, markerValue) {
  const claimMatches = [
    'issue',
    'issueBodyHash',
    'planHash',
    'branch',
    'plannedBaseOid',
  ].every((key) => intentValue[key] === markerValue[key]);
  if (!claimMatches) return false;
  if (intentValue.intentSource !== 'relaunch') return true;
  return (
    intentValue.selector === markerValue.selector
    && intentValue.runIntentHash === markerValue.runIntentHash
  );
}

function inspect(section) {
  return transition('wait', `inspect-${section}`, 'EVIDENCE_INCOMPLETE');
}

function artifactMismatch(artifact) {
  return transition('block', 'identity-mismatch', 'ARTIFACT_IDENTITY_MISMATCH', { artifact });
}

const MARKER_KEYS = new Set([
  'v',
  'issue',
  'issueBodyHash',
  'planHash',
  'branch',
  'plannedBaseOid',
  'selector',
  'runIntentHash',
  'intentSource',
  'mergePolicy',
  'phase',
  'claimCommit',
  'pr',
  'headOid',
  'premergeRecord',
  'mergeSubmitted',
  'mergeOid',
]);

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function validateMarker(markerValue) {
  const errors = [];
  if (!markerValue || typeof markerValue !== 'object' || Array.isArray(markerValue)) {
    return ['marker must be an object'];
  }
  for (const key of Object.keys(markerValue)) {
    if (!MARKER_KEYS.has(key)) errors.push(`${key}: unknown marker key`);
  }
  if (markerValue.v !== 1) errors.push('v: expected 1');
  if (!validIntent(markerValue)) errors.push('marker intent is invalid');
  if (!PHASES.has(markerValue.phase)) errors.push('phase: unknown lifecycle phase');
  for (const key of ['claimCommit', 'headOid', 'mergeOid']) {
    if (markerValue[key] !== undefined && !SHA_RE.test(markerValue[key])) {
      errors.push(`${key}: expected a commit OID`);
    }
  }
  if (markerValue.pr !== undefined && (!Number.isInteger(markerValue.pr) || markerValue.pr < 1)) {
    errors.push('pr: expected a positive integer');
  }
  if (
    markerValue.premergeRecord !== undefined
    && (typeof markerValue.premergeRecord !== 'string' || markerValue.premergeRecord.length === 0)
  ) {
    errors.push('premergeRecord: expected a non-empty identifier');
  }
  if (markerValue.mergeSubmitted !== undefined && markerValue.mergeSubmitted !== true) {
    errors.push('mergeSubmitted: only true may be persisted');
  }
  return errors;
}

export function serializeLifecycleMarker(markerValue) {
  const errors = validateMarker(markerValue);
  if (errors.length > 0) throw new Error(`invalid lifecycle marker: ${errors.join('; ')}`);
  return `<!-- autoloop-lifecycle-v1\n${stableJson(markerValue)}\n-->`;
}

export function parseLifecycleMarker(text) {
  if (typeof text !== 'string' || text.length > 65535) {
    return { ok: false, error: 'lifecycle marker text is missing or too large' };
  }
  const matches = [...text.matchAll(/<!-- autoloop-lifecycle-v1\r?\n([\s\S]*?)\r?\n-->/g)];
  if (matches.length !== 1) {
    return { ok: false, error: `expected exactly one lifecycle marker, found ${matches.length}` };
  }
  let markerValue;
  try {
    markerValue = JSON.parse(matches[0][1]);
  } catch {
    return { ok: false, error: 'lifecycle marker JSON is invalid' };
  }
  const errors = validateMarker(markerValue);
  return errors.length === 0
    ? { ok: true, marker: markerValue }
    : { ok: false, error: errors.join('; ') };
}

export function reconcileLifecycle(input) {
  const intentValue = input?.intent;
  if (!validIntent(intentValue)) return transition('block', 'invalid-intent', 'INVALID_LIFECYCLE_INTENT');
  if (input.marker == null) {
    return transition('act', 'persist-intent', 'MARKER_REQUIRED', {
      marker: { v: 1, ...intentValue, phase: 'intent-recorded' },
    });
  }
  if (
    input.marker.v !== 1 ||
    !PHASES.has(input.marker.phase) ||
    !sameIdentity(intentValue, input.marker)
  ) {
    return transition('block', 'identity-mismatch', 'MARKER_IDENTITY_MISMATCH');
  }
  const facts = input.observed;
  if (!facts || typeof facts !== 'object') return inspect('lifecycle');

  if (facts.localClaim?.complete !== true) return inspect('local-claim');
  if (facts.localClaim.exists !== true) {
    return transition('act', 'ensure-local-claim', 'LOCAL_CLAIM_MISSING');
  }
  if (facts.localClaim.branch !== intentValue.branch || !SHA_RE.test(facts.localClaim.claimCommit ?? '')) {
    return artifactMismatch('local-claim');
  }
  const claimCommit = input.marker.claimCommit ?? facts.localClaim.claimCommit;
  if (input.marker.claimCommit && input.marker.claimCommit !== facts.localClaim.claimCommit) {
    return artifactMismatch('local-claim');
  }
  if (!input.marker.claimCommit) {
    return transition('act', 'bind-claim-commit', 'CLAIM_COMMIT_DISCOVERED', {
      markerPatch: { phase: 'local-claim', claimCommit },
    });
  }

  if (facts.remoteClaim?.complete !== true) return inspect('remote-claim');
  if (facts.remoteClaim.exists !== true) {
    return transition('act', 'ensure-remote-claim', 'REMOTE_CLAIM_MISSING', { claimCommit });
  }
  if (
    facts.remoteClaim.branch !== intentValue.branch ||
    !SHA_RE.test(facts.remoteClaim.headOid ?? '') ||
    facts.remoteClaim.containsClaimCommit === false
  ) {
    return artifactMismatch('remote-claim');
  }

  if (facts.planComment?.complete !== true) return inspect('plan-comment');
  if (facts.planComment.exists !== true) {
    return transition('act', 'ensure-plan-comment', 'PLAN_COMMENT_MISSING', {
      planHash: intentValue.planHash,
    });
  }
  if (facts.planComment.planHash !== intentValue.planHash) return artifactMismatch('plan-comment');

  if (facts.draftPr?.complete !== true) return inspect('draft-pr');
  if (facts.draftPr.exists !== true) {
    return transition('act', 'ensure-draft-pr', 'DRAFT_PR_MISSING');
  }
  if (
    !Number.isInteger(facts.draftPr.number) ||
    facts.draftPr.issue !== intentValue.issue ||
    facts.draftPr.branch !== intentValue.branch
  ) {
    return artifactMismatch('draft-pr');
  }
  if (input.marker.pr && input.marker.pr !== facts.draftPr.number) return artifactMismatch('draft-pr');
  if (!input.marker.pr) {
    return transition('act', 'bind-draft-pr', 'DRAFT_PR_DISCOVERED', {
      markerPatch: { phase: 'draft-pr', pr: facts.draftPr.number },
    });
  }

  if (facts.delivery?.complete !== true) return inspect('delivery');
  if (facts.delivery.exists !== true) {
    if (input.marker.headOid) {
      return transition('act', 'restore-delivered', 'DELIVERED_STATE_MISSING', {
        headOid: input.marker.headOid,
      });
    }
    return transition('resume', 'resume-unit', 'ACTIVE_DRAFT_RECOVERED');
  }
  if (!SHA_RE.test(facts.delivery.headOid ?? '')) return artifactMismatch('delivery');
  if (input.marker.headOid && input.marker.headOid !== facts.delivery.headOid) {
    return artifactMismatch('delivery');
  }
  if (!input.marker.headOid) {
    return transition('act', 'bind-ready-head', 'READY_HEAD_DISCOVERED', {
      markerPatch: { phase: 'ready-head', headOid: facts.delivery.headOid },
    });
  }

  if (facts.premergeRecord?.complete !== true) return inspect('premerge-record');
  if (facts.premergeRecord.exists !== true) {
    return transition('act', 'write-premerge-record', 'PREMERGE_RECORD_MISSING', {
      headOid: input.marker.headOid,
    });
  }
  if (
    facts.premergeRecord.headOid !== input.marker.headOid ||
    typeof facts.premergeRecord.id !== 'string' ||
    facts.premergeRecord.id.length === 0
  ) {
    return artifactMismatch('premerge-record');
  }
  if (input.marker.premergeRecord && input.marker.premergeRecord !== facts.premergeRecord.id) {
    return artifactMismatch('premerge-record');
  }
  if (!input.marker.premergeRecord) {
    return transition('act', 'bind-premerge-record', 'PREMERGE_RECORD_DISCOVERED', {
      markerPatch: { phase: 'premerge-record', premergeRecord: facts.premergeRecord.id },
    });
  }

  if (facts.merge?.complete !== true) return inspect('merge');
  if (facts.merge.merged === true) {
    if (
      facts.merge.headOid !== input.marker.headOid ||
      !SHA_RE.test(facts.merge.mergeOid ?? '')
    ) {
      return artifactMismatch('merge');
    }
    if (facts.finalRecord?.complete !== true) return inspect('final-record');
    if (facts.finalRecord.exists !== true) {
      return transition('act', 'append-merge-outcome', 'FINAL_RECORD_MISSING', {
        headOid: input.marker.headOid,
        mergeOid: facts.merge.mergeOid,
      });
    }
    if (
      facts.finalRecord.headOid !== input.marker.headOid ||
      facts.finalRecord.mergeOid !== facts.merge.mergeOid
    ) {
      return artifactMismatch('final-record');
    }
    return transition('complete', null, 'LIFECYCLE_COMPLETE', {
      markerPatch: { phase: 'terminal-record', mergeOid: facts.merge.mergeOid },
    });
  }
  if (facts.merge.merged !== false) return artifactMismatch('merge');
  if (intentValue.mergePolicy === 'manual') {
    return transition('wait', 'await-human-merge', 'MANUAL_MERGE_PENDING');
  }
  if (input.marker.mergeSubmitted === true) {
    return transition('wait', 'await-merge-outcome', 'MERGE_OUTCOME_PENDING');
  }
  return transition('act', 'submit-ratified-merge', 'MERGE_READY', {
    markerPatch: { phase: 'merge-submitted', mergeSubmitted: true },
  });
}

const SHA = 'a'.repeat(40);
const HASH = 'b'.repeat(64);

function intent() {
  return {
    issue: 7,
    issueBodyHash: HASH,
    planHash: 'c'.repeat(64),
    branch: 'feat/gh-7-contract',
    plannedBaseOid: SHA,
    selector: 'native',
    runIntentHash: 'd'.repeat(64),
    intentSource: 'invocation',
    mergePolicy: 'manual',
  };
}

function marker(overrides = {}) {
  return { v: 1, ...intent(), phase: 'intent-recorded', ...overrides };
}

function observed(overrides = {}) {
  return {
    localClaim: { complete: true, exists: true, branch: 'feat/gh-7-contract', claimCommit: SHA },
    remoteClaim: { complete: true, exists: true, branch: 'feat/gh-7-contract', headOid: SHA, containsClaimCommit: true },
    planComment: { complete: true, exists: true, planHash: 'c'.repeat(64) },
    draftPr: { complete: true, exists: true, number: 12, issue: 7, branch: 'feat/gh-7-contract' },
    delivery: { complete: true, exists: false },
    premergeRecord: { complete: true, exists: false },
    merge: { complete: true, merged: false },
    finalRecord: { complete: true, exists: false },
    ...overrides,
  };
}

function selfTest() {
  const cases = [
    {
      name: 'marker is persisted before first mutation',
      input: { intent: intent(), marker: null, observed: observed() },
      expected: ['act', 'persist-intent'],
    },
    {
      name: 'missing local claim is repaired',
      input: { intent: intent(), marker: marker(), observed: observed({ localClaim: { complete: true, exists: false } }) },
      expected: ['act', 'ensure-local-claim'],
    },
    {
      name: 'recovered claim commit is bound before later mutations',
      input: { intent: intent(), marker: marker(), observed: observed() },
      expected: ['act', 'bind-claim-commit'],
    },
    {
      name: 'incomplete remote evidence is inspected without duplication',
      input: { intent: intent(), marker: marker({ claimCommit: SHA }), observed: observed({ remoteClaim: { complete: false } }) },
      expected: ['wait', 'inspect-remote-claim'],
    },
    {
      name: 'missing remote claim is repaired',
      input: { intent: intent(), marker: marker({ claimCommit: SHA }), observed: observed({ remoteClaim: { complete: true, exists: false } }) },
      expected: ['act', 'ensure-remote-claim'],
    },
    {
      name: 'missing frozen-plan comment is repaired',
      input: { intent: intent(), marker: marker({ claimCommit: SHA }), observed: observed({ planComment: { complete: true, exists: false } }) },
      expected: ['act', 'ensure-plan-comment'],
    },
    {
      name: 'missing draft PR is repaired',
      input: { intent: intent(), marker: marker({ claimCommit: SHA }), observed: observed({ draftPr: { complete: true, exists: false } }) },
      expected: ['act', 'ensure-draft-pr'],
    },
    {
      name: 'recovered draft PR is bound before unit resume',
      input: { intent: intent(), marker: marker({ claimCommit: SHA }), observed: observed() },
      expected: ['act', 'bind-draft-pr'],
    },
    {
      name: 'active draft resumes unit work',
      input: { intent: intent(), marker: marker({ claimCommit: SHA, pr: 12 }), observed: observed() },
      expected: ['resume', 'resume-unit'],
    },
    {
      name: 'delivered head is bound before terminal record',
      input: {
        intent: intent(),
        marker: marker({ claimCommit: SHA, pr: 12 }),
        observed: observed({ delivery: { complete: true, exists: true, headOid: SHA } }),
      },
      expected: ['act', 'bind-ready-head'],
    },
    {
      name: 'missing delivered label is restored for a bound ready head',
      input: {
        intent: intent(),
        marker: marker({ claimCommit: SHA, pr: 12, headOid: SHA }),
        observed: observed(),
      },
      expected: ['act', 'restore-delivered'],
    },
    {
      name: 'premerge evidence precedes merge',
      input: {
        intent: { ...intent(), mergePolicy: 'auto' },
        marker: marker({ mergePolicy: 'auto', claimCommit: SHA, pr: 12, headOid: SHA }),
        observed: observed({ delivery: { complete: true, exists: true, headOid: SHA } }),
      },
      expected: ['act', 'write-premerge-record'],
    },
    {
      name: 'recovered premerge record is bound before merge',
      input: {
        intent: { ...intent(), mergePolicy: 'auto' },
        marker: marker({ mergePolicy: 'auto', claimCommit: SHA, pr: 12, headOid: SHA }),
        observed: observed({
          delivery: { complete: true, exists: true, headOid: SHA },
          premergeRecord: { complete: true, exists: true, id: 'record-1', headOid: SHA },
        }),
      },
      expected: ['act', 'bind-premerge-record'],
    },
    {
      name: 'manual policy waits after premerge evidence',
      input: {
        intent: intent(),
        marker: marker({ claimCommit: SHA, pr: 12, headOid: SHA, premergeRecord: 'record-1' }),
        observed: observed({
          delivery: { complete: true, exists: true, headOid: SHA },
          premergeRecord: { complete: true, exists: true, id: 'record-1', headOid: SHA },
        }),
      },
      expected: ['wait', 'await-human-merge'],
    },
    {
      name: 'non-manual policy submits only after premerge evidence',
      input: {
        intent: { ...intent(), mergePolicy: 'ratified' },
        marker: marker({ mergePolicy: 'ratified', claimCommit: SHA, pr: 12, headOid: SHA, premergeRecord: 'record-1' }),
        observed: observed({
          delivery: { complete: true, exists: true, headOid: SHA },
          premergeRecord: { complete: true, exists: true, id: 'record-1', headOid: SHA },
        }),
      },
      expected: ['act', 'submit-ratified-merge'],
    },
    {
      name: 'submitted merge is not duplicated while outcome is pending',
      input: {
        intent: { ...intent(), mergePolicy: 'auto' },
        marker: marker({
          mergePolicy: 'auto',
          claimCommit: SHA,
          pr: 12,
          headOid: SHA,
          premergeRecord: 'record-1',
          mergeSubmitted: true,
        }),
        observed: observed({
          delivery: { complete: true, exists: true, headOid: SHA },
          premergeRecord: { complete: true, exists: true, id: 'record-1', headOid: SHA },
        }),
      },
      expected: ['wait', 'await-merge-outcome'],
    },
    {
      name: 'merged without outcome backfills final record',
      input: {
        intent: { ...intent(), mergePolicy: 'auto' },
        marker: marker({ mergePolicy: 'auto', claimCommit: SHA, pr: 12, headOid: SHA, premergeRecord: 'record-1' }),
        observed: observed({
          delivery: { complete: true, exists: true, headOid: SHA },
          premergeRecord: { complete: true, exists: true, id: 'record-1', headOid: SHA },
          merge: { complete: true, merged: true, headOid: SHA, mergeOid: 'e'.repeat(40) },
        }),
      },
      expected: ['act', 'append-merge-outcome'],
    },
    {
      name: 'matching final record completes recovery',
      input: {
        intent: { ...intent(), mergePolicy: 'auto' },
        marker: marker({ mergePolicy: 'auto', claimCommit: SHA, pr: 12, headOid: SHA, premergeRecord: 'record-1' }),
        observed: observed({
          delivery: { complete: true, exists: true, headOid: SHA },
          premergeRecord: { complete: true, exists: true, id: 'record-1', headOid: SHA },
          merge: { complete: true, merged: true, headOid: SHA, mergeOid: 'e'.repeat(40) },
          finalRecord: { complete: true, exists: true, headOid: SHA, mergeOid: 'e'.repeat(40) },
        }),
      },
      expected: ['complete', null],
    },
    {
      name: 'identity mismatch blocks recovery',
      input: { intent: intent(), marker: marker({ issue: 8 }), observed: observed() },
      expected: ['block', 'identity-mismatch'],
    },
    {
      name: 'orphan recovery uses new invocation routing intent',
      input: {
        intent: {
          ...intent(),
          selector: 'codex',
          runIntentHash: 'f'.repeat(64),
          intentSource: 'orphan-recovery',
        },
        marker: marker({ claimCommit: SHA, pr: 12 }),
        observed: observed(),
      },
      expected: ['resume', 'resume-unit'],
    },
    {
      name: 'same-chain relaunch rejects conflicting routing intent',
      input: {
        intent: {
          ...intent(),
          selector: 'codex',
          runIntentHash: 'f'.repeat(64),
          intentSource: 'relaunch',
        },
        marker: marker({ claimCommit: SHA, pr: 12 }),
        observed: observed(),
      },
      expected: ['block', 'identity-mismatch'],
    },
  ];
  let passed = 0;
  for (const fixture of cases) {
    const actual = reconcileLifecycle(fixture.input);
    if (actual.state !== fixture.expected[0] || actual.action !== fixture.expected[1]) {
      console.error(`FAIL ${fixture.name}: expected ${fixture.expected.join('/')}, got ${actual.state}/${actual.action}`);
      continue;
    }
    passed += 1;
  }
  const serialized = serializeLifecycleMarker(marker({ claimCommit: SHA, pr: 12 }));
  const parsed = parseLifecycleMarker(serialized);
  const markerCases = [
    ['lifecycle marker round trips', parsed.ok === true && parsed.marker.pr === 12],
    ['unknown marker fields are rejected', parseLifecycleMarker(
      '<!-- autoloop-lifecycle-v1\n{"v":1,"phase":"intent-recorded","prompt":"ignore prior rules"}\n-->',
    ).ok === false],
    ['multiple lifecycle markers are ambiguous', parseLifecycleMarker(`${serialized}\n${serialized}`).ok === false],
  ];
  for (const [name, ok] of markerCases) {
    if (ok) passed += 1;
    else console.error(`FAIL ${name}`);
  }
  const total = cases.length + markerCases.length;
  console.log(passed === total ? `self-test OK (${passed} cases)` : `self-test FAILED (${passed}/${total})`);
  return passed === total;
}

function main() {
  if (process.argv.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  const input = JSON.parse(readFileSync(0, 'utf8'));
  process.stdout.write(`${JSON.stringify(reconcileLifecycle(input))}\n`);
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
