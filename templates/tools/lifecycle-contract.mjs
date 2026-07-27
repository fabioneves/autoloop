#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  readFileSync,
  realpathSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseLoopBranchIssue } from './claim-contract.mjs';
import { finalizeHead } from './delivery-contract.mjs';
import {
  createPremergeRecord,
  createTerminalOutcome,
  premergeRecordHash,
  serializePremergeRecord,
  serializeTerminalOutcome,
  validPremergeRecordId,
  validatePremergeRecord,
} from './attestation-contract.mjs';

const SHA_RE = /^[0-9a-f]{40}$/i;
const HASH_RE = /^[0-9a-f]{64}$/i;
const COMMENT_ID_RE = /^[A-Za-z0-9_-]{1,255}$/u;
const LIFECYCLE_SUCCESSOR_KEYS = [
  'previousBodyHash',
  'previousCommentId',
  'rootCommentId',
  'sequence',
  'v',
];
const MAX_PRIOR_REVISIONS = 16;
const DELIVERY_REQUEST_KEYS = [
  'committedHead',
  'gatedHead',
  'pullRequest',
  'repository',
  'reviewedHead',
  'schemaVersion',
];
const TRUSTED_TEST_FINALIZER = Symbol('trusted-test-finalizer');
const PHASES = new Set([
  'intent-recorded',
  'local-claim',
  'remote-claim',
  'plan-comment',
  'draft-pr',
  'ready-head',
  'premerge-record',
  'merge-intent',
  'merge-attempt',
  'merge-result',
  'merge-refusal',
  'merge-unknown',
  'merge-submitted',
  'terminal-record',
]);
const MERGE_OPERATION_STATES = new Set([
  'intent',
  'attempt',
  'result',
  'refusal',
  'unknown',
]);

function transition(state, action, code, detail = {}) {
  return { state, action, code, ...detail };
}

function validIntent(intentValue) {
  const branchIssue = parseLoopBranchIssue(intentValue?.branch);
  return (
    Number.isSafeInteger(intentValue?.issue) &&
    intentValue.issue > 0 &&
    branchIssue === intentValue.issue &&
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
    'mergePolicy',
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

function completeExistence(value) {
  return value?.complete === true && typeof value.exists === 'boolean';
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
  'epoch',
  'planCommentId',
  'headOid',
  'premergeRecord',
  'premergeRecordHash',
  'premergeRecordCommentId',
  'mergeOperation',
  'mergeSubmitted',
  'mergeOid',
  'priorRevisions',
  'revisionIntent',
]);

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function exactKeys(value, keys) {
  return (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
  );
}

function validDeliveryRequest(value) {
  return (
    exactKeys(value, DELIVERY_REQUEST_KEYS)
    && value.schemaVersion === 1
    && /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/u
      .test(value.repository ?? '')
    && Number.isSafeInteger(value.pullRequest)
    && value.pullRequest > 0
    && SHA_RE.test(value.committedHead ?? '')
    && SHA_RE.test(value.reviewedHead ?? '')
    && SHA_RE.test(value.gatedHead ?? '')
  );
}

function finalizeDeliveryRequest(request, context) {
  if (!validDeliveryRequest(request)) return null;
  const trustedTestFinalizer = context[TRUSTED_TEST_FINALIZER];
  if (typeof trustedTestFinalizer === 'function') {
    return trustedTestFinalizer(structuredClone(request));
  }
  return finalizeHead(request, {
    repositoryRoot: context.repositoryRoot ?? process.cwd(),
  });
}

function deliveryRecordBinding(finalized, request) {
  const live = finalized?.liveEvidence;
  if (
    finalized?.canMarkDelivered !== true
    || finalized.headOid !== request.gatedHead
    || live?.repository !== request.repository
    || live?.pullRequest !== request.pullRequest
    || live?.remoteHead !== finalized.headOid
    || !HASH_RE.test(live?.provenance?.evidenceFingerprint ?? '')
  ) {
    return null;
  }
  return {
    evidenceHash: live.provenance.evidenceFingerprint,
  };
}

// CI-green alone is not ready-head evidence: on a head where no CI triggered,
// delivery is trivially green (NO_TRIGGERED_CHECKS), so a bare claim commit
// would "discover" a ready head it never earned — a live run wedged two units
// exactly this way (marker bound at the claim commit, every later push an
// identity mismatch). Ready-head discovery additionally requires both verdict
// statuses on the exact head: a genuinely crashed post-finalize unit has them
// (the finalizer posts them before the premerge record), a bare head cannot.
function verdictStatusesGreen(finalized) {
  const items = finalized?.liveEvidence?.statuses;
  if (!Array.isArray(items)) return false;
  return ['agentic/gate', 'agentic/review'].every((context) =>
    items.some((status) =>
      status?.context === context
      && String(status?.state ?? '').toUpperCase() === 'SUCCESS'));
}

export function lifecycleIdentityHash(markerValue) {
  const identity = {
    v: markerValue?.v,
    issue: markerValue?.issue,
    issueBodyHash: markerValue?.issueBodyHash,
    planHash: markerValue?.planHash,
    branch: markerValue?.branch,
    plannedBaseOid: markerValue?.plannedBaseOid,
    selector: markerValue?.selector,
    runIntentHash: markerValue?.runIntentHash,
    intentSource: markerValue?.intentSource,
    mergePolicy: markerValue?.mergePolicy,
    claimCommit: markerValue?.claimCommit,
    pr: markerValue?.pr,
    headOid: markerValue?.headOid,
    ...(markerValue?.epoch === undefined ? {} : { epoch: markerValue.epoch }),
  };
  if (
    !Number.isSafeInteger(identity.issue)
    || identity.issue < 1
    || !Number.isSafeInteger(identity.pr)
    || identity.pr < 1
    || !SHA_RE.test(identity.headOid ?? '')
  ) {
    return null;
  }
  return createHash('sha256').update(stableJson(identity)).digest('hex');
}

const REVISION_REQUEST_KEYS = [
  'expectedEpoch',
  'expectedHeadOid',
  'expectedIdentityHash',
  'expectedPlanCommentId',
  'expectedPremergeRecord',
  'expectedPremergeRecordCommentId',
  'expectedPremergeRecordHash',
  'planCommentId',
  'planHash',
  'plannedBaseOid',
  'runIntentHash',
  'selector',
];

const REVISION_INTENT_KEYS = [
  'fromEpoch',
  'fromHeadOid',
  'fromIdentityHash',
  'fromPlanCommentId',
  'fromPremergeRecord',
  'fromPremergeRecordCommentId',
  'fromPremergeRecordHash',
  'intentHash',
  'planCommentId',
  'planHash',
  'plannedBaseOid',
  'runIntentHash',
  'selector',
  'toEpoch',
];

const PRIOR_REVISION_KEYS = [
  'epoch',
  'headOid',
  'identityHash',
  'planCommentId',
  'planHash',
  'plannedBaseOid',
  'premergeRecord',
  'premergeRecordCommentId',
  'premergeRecordHash',
  'revisionIntentHash',
  'runIntentHash',
  'selector',
];

function validRevisionRequest(value) {
  return (
    exactKeys(value, REVISION_REQUEST_KEYS)
    && Number.isSafeInteger(value.expectedEpoch)
    && value.expectedEpoch > 0
    && SHA_RE.test(value.expectedHeadOid ?? '')
    && HASH_RE.test(value.expectedIdentityHash ?? '')
    && COMMENT_ID_RE.test(value.expectedPlanCommentId ?? '')
    && validPremergeRecordId(value.expectedPremergeRecord)
    && COMMENT_ID_RE.test(value.expectedPremergeRecordCommentId ?? '')
    && HASH_RE.test(value.expectedPremergeRecordHash ?? '')
    && COMMENT_ID_RE.test(value.planCommentId ?? '')
    && HASH_RE.test(value.planHash ?? '')
    && SHA_RE.test(value.plannedBaseOid ?? '')
    && HASH_RE.test(value.runIntentHash ?? '')
    && new Set(['native', 'claude', 'codex', 'opencode']).has(value.selector)
  );
}

function revisionIntentFor(request) {
  const intentHash = createHash('sha256')
    .update(stableJson(request))
    .digest('hex');
  return {
    fromEpoch: request.expectedEpoch,
    fromHeadOid: request.expectedHeadOid,
    fromIdentityHash: request.expectedIdentityHash,
    fromPlanCommentId: request.expectedPlanCommentId,
    fromPremergeRecord: request.expectedPremergeRecord,
    fromPremergeRecordCommentId: request.expectedPremergeRecordCommentId,
    fromPremergeRecordHash: request.expectedPremergeRecordHash,
    intentHash,
    planCommentId: request.planCommentId,
    planHash: request.planHash,
    plannedBaseOid: request.plannedBaseOid,
    runIntentHash: request.runIntentHash,
    selector: request.selector,
    toEpoch: request.expectedEpoch + 1,
  };
}

function validRevisionIntent(value) {
  return (
    exactKeys(value, REVISION_INTENT_KEYS)
    && Number.isSafeInteger(value.fromEpoch)
    && value.fromEpoch > 0
    && value.toEpoch === value.fromEpoch + 1
    && SHA_RE.test(value.fromHeadOid ?? '')
    && HASH_RE.test(value.fromIdentityHash ?? '')
    && COMMENT_ID_RE.test(value.fromPlanCommentId ?? '')
    && validPremergeRecordId(value.fromPremergeRecord)
    && COMMENT_ID_RE.test(value.fromPremergeRecordCommentId ?? '')
    && HASH_RE.test(value.fromPremergeRecordHash ?? '')
    && HASH_RE.test(value.intentHash ?? '')
    && COMMENT_ID_RE.test(value.planCommentId ?? '')
    && HASH_RE.test(value.planHash ?? '')
    && SHA_RE.test(value.plannedBaseOid ?? '')
    && HASH_RE.test(value.runIntentHash ?? '')
    && new Set(['native', 'claude', 'codex', 'opencode']).has(value.selector)
  );
}

function validPriorRevision(value) {
  return (
    exactKeys(value, PRIOR_REVISION_KEYS)
    && Number.isSafeInteger(value.epoch)
    && value.epoch > 0
    && SHA_RE.test(value.headOid ?? '')
    && HASH_RE.test(value.identityHash ?? '')
    && COMMENT_ID_RE.test(value.planCommentId ?? '')
    && HASH_RE.test(value.planHash ?? '')
    && SHA_RE.test(value.plannedBaseOid ?? '')
    && validPremergeRecordId(value.premergeRecord)
    && COMMENT_ID_RE.test(value.premergeRecordCommentId ?? '')
    && HASH_RE.test(value.premergeRecordHash ?? '')
    && HASH_RE.test(value.revisionIntentHash ?? '')
    && HASH_RE.test(value.runIntentHash ?? '')
    && new Set(['native', 'claude', 'codex', 'opencode']).has(value.selector)
  );
}

function priorRevisionFor(markerValue, revisionIntent) {
  return {
    epoch: revisionIntent.fromEpoch,
    headOid: revisionIntent.fromHeadOid,
    identityHash: revisionIntent.fromIdentityHash,
    planCommentId: revisionIntent.fromPlanCommentId,
    planHash: markerValue.planHash,
    plannedBaseOid: markerValue.plannedBaseOid,
    premergeRecord: revisionIntent.fromPremergeRecord,
    premergeRecordCommentId: revisionIntent.fromPremergeRecordCommentId,
    premergeRecordHash: revisionIntent.fromPremergeRecordHash,
    revisionIntentHash: revisionIntent.intentHash,
    runIntentHash: markerValue.runIntentHash,
    selector: markerValue.selector,
  };
}

export function beginLifecycleRevision(markerValue, request) {
  const markerErrors = validateMarker(markerValue);
  if (markerErrors.length > 0 || !validRevisionRequest(request)) {
    return transition('block', 'invalid-revision', 'INVALID_REVISION_REQUEST');
  }
  const revisionIntent = revisionIntentFor(request);
  const priorRevisions = markerValue.priorRevisions ?? [];
  const replay = priorRevisions.find(
    (entry) => entry.revisionIntentHash === revisionIntent.intentHash,
  );
  if (replay) {
    const replayEpoch = replay.epoch + 1;
    if (
      (markerValue.epoch ?? 1) === replayEpoch
      && markerValue.planCommentId === revisionIntent.planCommentId
      && markerValue.planHash === revisionIntent.planHash
      && markerValue.plannedBaseOid === revisionIntent.plannedBaseOid
      && markerValue.runIntentHash === revisionIntent.runIntentHash
      && markerValue.selector === revisionIntent.selector
    ) {
      return transition('complete', null, 'REVISION_ALREADY_BEGUN', {
        epoch: replayEpoch,
      });
    }
    return transition('block', 'revision-race', 'REVISION_SOURCE_MISMATCH');
  }
  if (markerValue.revisionIntent) {
    return stableJson(markerValue.revisionIntent) === stableJson(revisionIntent)
      ? transition('wait', 'readback-revision-prerequisites', 'REVISION_INTENT_STAGED')
      : transition('block', 'revision-race', 'REVISION_INTENT_CONFLICT');
  }
  const epoch = markerValue.epoch ?? 1;
  if (
    markerValue.phase !== 'premerge-record'
    || epoch !== request.expectedEpoch
    || markerValue.headOid !== request.expectedHeadOid
    || lifecycleIdentityHash(markerValue) !== request.expectedIdentityHash
    || markerValue.planCommentId !== request.expectedPlanCommentId
    || markerValue.premergeRecord !== request.expectedPremergeRecord
    || markerValue.premergeRecordCommentId
      !== request.expectedPremergeRecordCommentId
    || markerValue.premergeRecordHash !== request.expectedPremergeRecordHash
    || markerValue.mergeOperation !== undefined
    || markerValue.mergeSubmitted !== undefined
    || markerValue.mergeOid !== undefined
  ) {
    return transition('block', 'revision-race', 'REVISION_SOURCE_MISMATCH');
  }
  if (priorRevisions.length >= MAX_PRIOR_REVISIONS) {
    return transition('block', 'revision-cap', 'REVISION_AUDIT_CAP_REACHED');
  }
  return transition('act', 'stage-revision-intent', 'REVISION_INTENT_REQUIRED', {
    marker: { ...markerValue, revisionIntent },
  });
}

export function advanceLifecycleRevision(markerValue, observed) {
  const errors = validateMarker(markerValue);
  const revisionIntent = markerValue?.revisionIntent;
  if (errors.length > 0 || !validRevisionIntent(revisionIntent)) {
    return transition('block', 'invalid-revision', 'INVALID_STAGED_REVISION');
  }
  if (
    !exactKeys(observed, ['complete', 'headOid', 'labels', 'planComment'])
    || observed.complete !== true
    || !SHA_RE.test(observed.headOid ?? '')
    || !Array.isArray(observed.labels)
    || observed.labels.some((label) => typeof label !== 'string')
    || new Set(observed.labels).size !== observed.labels.length
    || !exactKeys(observed.planComment, ['bodyHash', 'complete', 'id'])
    || observed.planComment.complete !== true
  ) {
    return inspect('revision-prerequisites');
  }
  if (
    observed.headOid !== revisionIntent.fromHeadOid
    || !observed.labels.includes('loop:revising')
    || observed.labels.includes('loop-delivered')
    || observed.planComment.id !== revisionIntent.planCommentId
    || observed.planComment.bodyHash !== revisionIntent.planHash
  ) {
    return transition('block', 'revision-race', 'REVISION_PREREQUISITE_MISMATCH');
  }
  const priorRevisions = [
    ...(markerValue.priorRevisions ?? []),
    priorRevisionFor(markerValue, revisionIntent),
  ];
  const {
    headOid: ignoredHead,
    mergeOid: ignoredMergeOid,
    mergeOperation: ignoredMergeOperation,
    mergeSubmitted: ignoredMergeSubmitted,
    premergeRecord: ignoredRecord,
    premergeRecordHash: ignoredRecordHash,
    premergeRecordCommentId: ignoredRecordComment,
    revisionIntent: ignoredRevisionIntent,
    ...identity
  } = markerValue;
  return transition('act', 'begin-revision-epoch', 'REVISION_PREREQUISITES_VERIFIED', {
    marker: {
      ...identity,
      epoch: revisionIntent.toEpoch,
      intentSource: 'relaunch',
      phase: 'draft-pr',
      planCommentId: revisionIntent.planCommentId,
      planHash: revisionIntent.planHash,
      plannedBaseOid: revisionIntent.plannedBaseOid,
      priorRevisions,
      runIntentHash: revisionIntent.runIntentHash,
      selector: revisionIntent.selector,
    },
  });
}

function validMergeOperation(value) {
  return (
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join('\0')
      === ['headOid', 'kind', 'premergeRecord', 'state'].join('\0')
    && value.kind === 'strict-direct'
    && MERGE_OPERATION_STATES.has(value.state)
    && SHA_RE.test(value.headOid ?? '')
    && validPremergeRecordId(value.premergeRecord)
  );
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
    markerValue.epoch !== undefined
    && (!Number.isSafeInteger(markerValue.epoch) || markerValue.epoch < 1)
  ) {
    errors.push('epoch: expected a positive safe integer');
  }
  if (
    markerValue.planCommentId !== undefined
    && !COMMENT_ID_RE.test(markerValue.planCommentId)
  ) {
    errors.push('planCommentId: expected a GitHub comment ID');
  }
  if (
    markerValue.priorRevisions !== undefined
    && (
      !Array.isArray(markerValue.priorRevisions)
      || markerValue.priorRevisions.length > MAX_PRIOR_REVISIONS
      || markerValue.priorRevisions.some((entry) => !validPriorRevision(entry))
      || markerValue.priorRevisions.some(
        (entry, index) => entry.epoch !== index + 1,
      )
      || new Set(
        markerValue.priorRevisions.map((entry) => entry.revisionIntentHash),
      ).size !== markerValue.priorRevisions.length
    )
  ) {
    errors.push('priorRevisions: invalid immutable revision audit');
  }
  if (
    markerValue.epoch !== undefined
    && markerValue.epoch !== (markerValue.priorRevisions?.length ?? 0) + 1
  ) {
    errors.push('epoch: does not follow the prior revision audit');
  }
  if (
    markerValue.revisionIntent !== undefined
    && (
      !validRevisionIntent(markerValue.revisionIntent)
      || markerValue.phase !== 'premerge-record'
      || markerValue.revisionIntent.fromEpoch !== (markerValue.epoch ?? 1)
      || markerValue.revisionIntent.fromHeadOid !== markerValue.headOid
      || markerValue.revisionIntent.fromIdentityHash
        !== lifecycleIdentityHash(markerValue)
      || markerValue.revisionIntent.fromPlanCommentId
        !== markerValue.planCommentId
      || markerValue.revisionIntent.fromPremergeRecord
        !== markerValue.premergeRecord
      || markerValue.revisionIntent.fromPremergeRecordCommentId
        !== markerValue.premergeRecordCommentId
      || markerValue.revisionIntent.fromPremergeRecordHash
        !== markerValue.premergeRecordHash
    )
  ) {
    errors.push('revisionIntent: invalid staged revision identity');
  }
  if (
    markerValue.premergeRecord !== undefined
    && !validPremergeRecordId(markerValue.premergeRecord)
  ) {
    errors.push('premergeRecord: expected a strict premerge record ID');
  }
  const premergeIdentity = [
    markerValue.premergeRecord,
    markerValue.premergeRecordHash,
    markerValue.premergeRecordCommentId,
  ];
  if (
    premergeIdentity.some((value) => value !== undefined)
    && (
      !validPremergeRecordId(markerValue.premergeRecord)
      || !HASH_RE.test(markerValue.premergeRecordHash ?? '')
      || typeof markerValue.premergeRecordCommentId !== 'string'
      || markerValue.premergeRecordCommentId.length === 0
    )
  ) {
    errors.push('premerge record identity must include strict ID, hash, and comment ID');
  }
  if (markerValue.mergeSubmitted !== undefined && markerValue.mergeSubmitted !== true) {
    errors.push('mergeSubmitted: only true may be persisted');
  }
  if (
    markerValue.mergeOperation !== undefined
    && !validMergeOperation(markerValue.mergeOperation)
  ) {
    errors.push('mergeOperation: invalid strict-direct operation');
  }
  if (
    markerValue.mergeOperation
    && (
      markerValue.mergeOperation.headOid !== markerValue.headOid
      || markerValue.mergeOperation.premergeRecord !== markerValue.premergeRecord
      || (
        markerValue.phase !== `merge-${markerValue.mergeOperation.state}`
        && markerValue.phase !== 'terminal-record'
      )
    )
  ) {
    errors.push('mergeOperation: identity or phase mismatch');
  }
  if (markerValue.mergeOperation && markerValue.mergePolicy === 'manual') {
    errors.push('mergeOperation: manual policy cannot submit a merge');
  }
  if (markerValue.mergeOperation && markerValue.mergeSubmitted) {
    errors.push('mergeOperation: cannot coexist with legacy mergeSubmitted');
  }
  if (
    typeof markerValue.phase === 'string'
    && markerValue.phase.startsWith('merge-')
    && markerValue.phase !== 'merge-submitted'
    && !markerValue.mergeOperation
  ) {
    errors.push('phase: typed merge phase requires mergeOperation');
  }
  if (
    markerValue.mergeSubmitted
    && (
      markerValue.mergePolicy === 'manual'
      || !['merge-submitted', 'terminal-record'].includes(markerValue.phase)
      || !markerValue.headOid
      || !markerValue.premergeRecord
    )
  ) {
    errors.push('mergeSubmitted: invalid legacy submission state');
  }
  if (markerValue.phase === 'merge-submitted' && !markerValue.mergeSubmitted) {
    errors.push('phase: legacy merge submission requires mergeSubmitted');
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

function validateLifecycleSuccessor(value) {
  return (
    exactKeys(value, LIFECYCLE_SUCCESSOR_KEYS)
    && value.v === 1
    && COMMENT_ID_RE.test(value.rootCommentId ?? '')
    && COMMENT_ID_RE.test(value.previousCommentId ?? '')
    && HASH_RE.test(value.previousBodyHash ?? '')
    && Number.isSafeInteger(value.sequence)
    && value.sequence >= 1
  );
}

export function serializeLifecycleSuccessor(markerValue, successor) {
  const markerBody = serializeLifecycleMarker(markerValue);
  if (!validateLifecycleSuccessor(successor)) {
    throw new Error('invalid lifecycle successor');
  }
  return `${markerBody}\n<!-- autoloop-lifecycle-successor-v1\n`
    + `${stableJson(successor)}\n-->`;
}

export function parseLifecycleComment(text) {
  const parsed = parseLifecycleMarker(text);
  if (!parsed.ok) return parsed;
  const matches = [...String(text).matchAll(
    /<!-- autoloop-lifecycle-successor-v1\r?\n([\s\S]*?)\r?\n-->/gu,
  )];
  if (matches.length === 0) {
    if (text !== serializeLifecycleMarker(parsed.marker)) {
      return { ok: false, error: 'root lifecycle comment is not canonical' };
    }
    return { ok: true, marker: parsed.marker, successor: null };
  }
  if (matches.length !== 1) {
    return {
      ok: false,
      error: `expected at most one lifecycle successor, found ${matches.length}`,
    };
  }
  let successor;
  try {
    successor = JSON.parse(matches[0][1]);
  } catch {
    return { ok: false, error: 'lifecycle successor JSON is invalid' };
  }
  if (!validateLifecycleSuccessor(successor)) {
    return { ok: false, error: 'lifecycle successor is invalid' };
  }
  if (text !== serializeLifecycleSuccessor(parsed.marker, successor)) {
    return { ok: false, error: 'lifecycle successor comment is not canonical' };
  }
  return { ok: true, marker: parsed.marker, successor };
}

function lifecycleCommentBodyHash(body) {
  return createHash('sha256').update(body).digest('hex');
}

// Chain input requires positive never-edited evidence, so absent evidence is
// edited. GraphQL `lastEditedAt` is authoritative; REST callers normalize
// `created_at`/`updated_at` into `createdAt`/`updatedAt`, whose equality is the
// only other positive proof GitHub exposes for an unedited comment body.
export function lifecycleCommentNeverEdited(evidence) {
  if (evidence === null || typeof evidence !== 'object') return false;
  const { lastEditedAt, createdAt, updatedAt } = evidence;
  if (lastEditedAt === null) return true;
  if (lastEditedAt !== undefined) return false;
  return typeof createdAt === 'string'
    && createdAt.length > 0
    && createdAt === updatedAt;
}

export function resolveLifecycleCommentChain(comments, rootCommentId = null) {
  if (
    !Array.isArray(comments)
    || comments.some((comment) =>
      !exactKeys(comment, ['body', 'id', 'neverEdited'])
      || !COMMENT_ID_RE.test(comment.id ?? '')
      || typeof comment.body !== 'string'
      || typeof comment.neverEdited !== 'boolean')
    || new Set(comments.map((comment) => comment.id)).size !== comments.length
    || (
      rootCommentId !== null
      && !COMMENT_ID_RE.test(rootCommentId ?? '')
    )
  ) {
    throw new Error('lifecycle comment chain input is invalid');
  }
  const entries = comments
    .filter((comment) => comment.body.includes('autoloop-lifecycle-v1'))
    .map((comment) => ({
      ...comment,
      parsed: parseLifecycleComment(comment.body),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (entries.some((entry) => !entry.parsed.ok)) {
    throw new Error('authoritative lifecycle comment is malformed');
  }
  const roots = entries.filter((entry) => entry.parsed.successor === null);
  if (roots.length === 0) {
    if (rootCommentId !== null) {
      throw new Error('captured lifecycle root comment is unavailable');
    }
    return null;
  }
  const rootBodies = new Set(roots.map((entry) => entry.body));
  if (rootBodies.size !== 1) {
    throw new Error('authoritative lifecycle root is ambiguous');
  }
  const root = roots[0];
  if (rootCommentId !== null && root.id !== rootCommentId) {
    throw new Error('captured lifecycle root comment is not canonical');
  }
  const successors = entries.filter((entry) => entry.parsed.successor !== null);
  if (successors.some((entry) => !entry.neverEdited)) {
    throw new Error('authoritative lifecycle successor was edited');
  }
  let tip = root;
  let sequence = 0;
  const consumed = new Set();
  for (;;) {
    const expectedHash = lifecycleCommentBodyHash(tip.body);
    const children = successors.filter((entry) => {
      const link = entry.parsed.successor;
      return link.rootCommentId === root.id
        && link.previousCommentId === tip.id
        && link.previousBodyHash === expectedHash
        && link.sequence === sequence + 1;
    });
    if (children.length === 0) break;
    const bodies = new Set(children.map((entry) => entry.body));
    if (bodies.size !== 1) {
      throw new Error('authoritative lifecycle successor fork is ambiguous');
    }
    for (const child of children) consumed.add(child.id);
    tip = children[0];
    sequence += 1;
  }
  if (successors.some((entry) => !consumed.has(entry.id))) {
    throw new Error('authoritative lifecycle successor is stale or disconnected');
  }
  if (!root.neverEdited && sequence === 0) {
    throw new Error('edited lifecycle root is not hash-anchored');
  }
  return {
    root: { id: root.id, body: root.body, marker: root.parsed.marker },
    tip: { id: tip.id, body: tip.body, marker: tip.parsed.marker },
    sequence,
  };
}

export function classifyStrictDirectAttempt(input) {
  const identityComplete = (
    Number.isSafeInteger(input?.pr)
    && input.pr > 0
    && SHA_RE.test(input?.headOid ?? '')
    && validPremergeRecordId(input?.premergeRecord)
  );
  const base = {
    complete: identityComplete,
    kind: 'strict-direct',
    state: 'unknown',
    headOid: identityComplete ? input.headOid : null,
    premergeRecord: identityComplete ? input.premergeRecord : null,
  };
  if (
    !identityComplete
    || !Number.isInteger(input?.exitCode)
    || typeof input?.stdout !== 'string'
    || typeof input?.stderr !== 'string'
  ) {
    return base;
  }
  const output = `${input.stdout}\n${input.stderr}`;
  const merged = `MERGED #${input.pr} (squash, sha=${input.headOid})`;
  if (input.exitCode === 0 && output.split(/\r?\n/).includes(merged)) {
    return { ...base, state: 'result' };
  }
  const refused = new RegExp(`(?:^|\\n)REFUSE #${input.pr}\\b`).test(output);
  if (
    input.exitCode !== 0
    && refused
    && !output.includes('LOUD: MERGE OUTCOME UNKNOWN')
  ) {
    return { ...base, state: 'refusal' };
  }
  return base;
}

function mergeOperation(markerValue, state) {
  return {
    kind: 'strict-direct',
    state,
    headOid: markerValue.headOid,
    premergeRecord: markerValue.premergeRecord,
  };
}

function sameMergeOperation(left, right) {
  return (
    validMergeOperation(left)
    && right
    && typeof right === 'object'
    && !Array.isArray(right)
    && Object.keys(right).sort().join('\0')
      === ['complete', 'headOid', 'kind', 'premergeRecord', 'state'].join('\0')
    && right.complete === true
    && validMergeOperation({
      kind: right.kind,
      state: right.state,
      headOid: right.headOid,
      premergeRecord: right.premergeRecord,
    })
    && left.kind === right.kind
    && left.headOid === right.headOid
    && left.premergeRecord === right.premergeRecord
  );
}

function expectedPremergeRecord(input, ciBinding, requireCiBinding) {
  const record = input?.premergeRecordDraft;
  const markerValue = input?.marker;
  if (
    validatePremergeRecord(record).length > 0
    || record.issue !== markerValue?.issue
    || record.pullRequest !== markerValue?.pr
    || record.headOid !== markerValue?.headOid
    || record.run.intentHash !== markerValue?.runIntentHash
    || record.plan.contentHash !== markerValue?.planHash
    || record.lifecycle.identityHash !== lifecycleIdentityHash(markerValue)
    || requireCiBinding
      && (
        ciBinding === null
        || record.ci.evidenceHash !== ciBinding.evidenceHash
      )
  ) {
    return null;
  }
  return record;
}

export function reconcileLifecycle(input, context = {}) {
  const intentValue = input?.intent;
  if (!validIntent(intentValue)) return transition('block', 'invalid-intent', 'INVALID_LIFECYCLE_INTENT');
  if (input.marker == null) {
    return transition('act', 'persist-intent', 'MARKER_REQUIRED', {
      marker: { v: 1, ...intentValue, epoch: 1, phase: 'intent-recorded' },
    });
  }
  if (
    validateMarker(input.marker).length > 0 ||
    !sameIdentity(intentValue, input.marker)
  ) {
    return transition('block', 'identity-mismatch', 'MARKER_IDENTITY_MISMATCH');
  }
  const facts = input.observed;
  if (!facts || typeof facts !== 'object') return inspect('lifecycle');
  if (facts.merge?.complete === true && typeof facts.merge.merged !== 'boolean') {
    return artifactMismatch('merge');
  }
  const merged = facts.merge?.complete === true && facts.merge.merged === true;
  const readyIdentityComplete = (
    SHA_RE.test(input.marker.claimCommit ?? '')
    && Number.isInteger(input.marker.pr)
    && SHA_RE.test(input.marker.headOid ?? '')
  );
  if (readyIdentityComplete && facts.merge?.complete !== true) return inspect('merge');
  if (
    merged
    && (
      !SHA_RE.test(facts.merge.headOid ?? '')
      || !SHA_RE.test(facts.merge.mergeOid ?? '')
      || (input.marker.headOid && facts.merge.headOid !== input.marker.headOid)
    )
  ) {
    return artifactMismatch('merge');
  }

  if (!completeExistence(facts.localClaim)) return inspect('local-claim');
  if (facts.localClaim.exists !== true) {
    if (!merged) return transition('act', 'ensure-local-claim', 'LOCAL_CLAIM_MISSING');
    if (!input.marker.claimCommit) return artifactMismatch('terminal-marker');
  } else {
    if (
      facts.localClaim.branch !== intentValue.branch
      || !SHA_RE.test(facts.localClaim.claimCommit ?? '')
    ) {
      return artifactMismatch('local-claim');
    }
    if (
      input.marker.claimCommit
      && input.marker.claimCommit !== facts.localClaim.claimCommit
    ) {
      return artifactMismatch('local-claim');
    }
  }
  const claimCommit = input.marker.claimCommit ?? facts.localClaim.claimCommit;
  if (!input.marker.claimCommit) {
    return transition('act', 'bind-claim-commit', 'CLAIM_COMMIT_DISCOVERED', {
      markerPatch: { phase: 'local-claim', claimCommit },
    });
  }

  if (!completeExistence(facts.remoteClaim)) return inspect('remote-claim');
  if (facts.remoteClaim.exists !== true) {
    if (!merged) {
      return transition('act', 'ensure-remote-claim', 'REMOTE_CLAIM_MISSING', { claimCommit });
    }
  } else {
    if (
      facts.remoteClaim.branch !== intentValue.branch
      || !SHA_RE.test(facts.remoteClaim.headOid ?? '')
    ) {
      return artifactMismatch('remote-claim');
    }
    if (facts.remoteClaim.containsClaimCommit == null) return inspect('remote-claim');
    if (facts.remoteClaim.containsClaimCommit !== true) return artifactMismatch('remote-claim');
    if (
      merged
      && input.marker.headOid
      && facts.remoteClaim.headOid !== input.marker.headOid
    ) {
      return artifactMismatch('remote-claim');
    }
  }

  if (!completeExistence(facts.planComment)) return inspect('plan-comment');
  if (facts.planComment.exists !== true) {
    if (merged) return artifactMismatch('plan-comment');
    return transition('act', 'ensure-plan-comment', 'PLAN_COMMENT_MISSING', {
      planHash: intentValue.planHash,
    });
  }
  if (facts.planComment.planHash !== intentValue.planHash) return artifactMismatch('plan-comment');
  if (
    input.marker.planCommentId
    && input.marker.planCommentId !== facts.planComment.id
  ) {
    return artifactMismatch('plan-comment');
  }
  if (
    !input.marker.planCommentId
    && COMMENT_ID_RE.test(facts.planComment.id ?? '')
  ) {
    return transition('act', 'bind-plan-comment', 'PLAN_COMMENT_DISCOVERED', {
      markerPatch: { phase: 'plan-comment', planCommentId: facts.planComment.id },
    });
  }

  if (!completeExistence(facts.draftPr)) return inspect('draft-pr');
  if (facts.draftPr.exists !== true) {
    if (merged) return artifactMismatch('draft-pr');
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

  // A ready-head bound to a superseded head is re-convergence work, not a
  // permanent wedge: the claim-verified remote head moving past the bound head
  // invalidates the old verdicts, so the marker returns to draft-pr and the
  // evidence re-accumulates on the new head — rediscovery below demands fresh
  // verdict statuses, so unbinding never skips review or gate. Revision,
  // premerge, and merge markers keep their stricter machinery.
  if (
    !merged
    && input.marker.phase === 'ready-head'
    && SHA_RE.test(input.marker.headOid ?? '')
    && input.marker.revisionIntent === undefined
    && input.marker.premergeRecord === undefined
    && input.marker.mergeOperation === undefined
    && facts.remoteClaim.exists === true
    && SHA_RE.test(facts.remoteClaim.headOid ?? '')
    && facts.remoteClaim.headOid !== input.marker.headOid
  ) {
    const { headOid: supersededHeadOid, ...unbound } = input.marker;
    return transition('act', 'unbind-ready-head', 'READY_HEAD_SUPERSEDED', {
      supersededHeadOid,
      marker: { ...unbound, phase: 'draft-pr' },
    });
  }

  if (!completeExistence(facts.delivery)) return inspect('delivery');
  let restoreDelivery = false;
  let deliveryBinding = null;
  if (!merged) {
    if (facts.delivery.exists !== true) {
      if (!input.marker.headOid) {
        if (facts.delivery.request == null) {
          return transition('resume', 'resume-unit', 'ACTIVE_DRAFT_RECOVERED');
        }
        const finalizedDelivery = finalizeDeliveryRequest(
          facts.delivery.request,
          context,
        );
        deliveryBinding = deliveryRecordBinding(
          finalizedDelivery,
          facts.delivery.request,
        );
        if (deliveryBinding === null) return inspect('delivery');
        if (
          facts.remoteClaim.exists !== true
          || finalizedDelivery.headOid !== facts.remoteClaim.headOid
        ) {
          return artifactMismatch('delivery');
        }
        if (!verdictStatusesGreen(finalizedDelivery)) {
          return transition('resume', 'resume-unit', 'ACTIVE_DRAFT_RECOVERED');
        }
        return transition('act', 'bind-ready-head', 'READY_HEAD_DISCOVERED', {
          markerPatch: { phase: 'ready-head', headOid: finalizedDelivery.headOid },
        });
      }
      const finalizedDelivery = finalizeDeliveryRequest(
        facts.delivery.request,
        context,
      );
      deliveryBinding = deliveryRecordBinding(
        finalizedDelivery,
        facts.delivery.request,
      );
      if (deliveryBinding === null) return inspect('delivery');
      const expectedRemoteHead = facts.remoteClaim.exists === true
        ? facts.remoteClaim.headOid
        : input.marker.headOid;
      if (
        finalizedDelivery.headOid !== expectedRemoteHead
        || finalizedDelivery.headOid !== input.marker.headOid
      ) {
        return artifactMismatch('delivery');
      }
      restoreDelivery = true;
    } else {
      const finalizedDelivery = finalizeDeliveryRequest(
        facts.delivery.request,
        context,
      );
      deliveryBinding = deliveryRecordBinding(
        finalizedDelivery,
        facts.delivery.request,
      );
      if (deliveryBinding === null) return inspect('delivery');
      const expectedRemoteHead = facts.remoteClaim.exists === true
        ? facts.remoteClaim.headOid
        : input.marker.headOid;
      if (
        finalizedDelivery.headOid !== expectedRemoteHead
        || (input.marker.headOid && finalizedDelivery.headOid !== input.marker.headOid)
      ) {
        return artifactMismatch('delivery');
      }
      if (
        !SHA_RE.test(facts.delivery.headOid ?? '')
        || facts.delivery.headOid !== finalizedDelivery.headOid
      ) {
        return artifactMismatch('delivery');
      }
      if (input.marker.headOid && input.marker.headOid !== facts.delivery.headOid) {
        return artifactMismatch('delivery');
      }
      if (!input.marker.headOid) {
        // A loop-delivered label without both verdict statuses on the head is
        // an inconsistent world, not a rediscovery.
        if (!verdictStatusesGreen(finalizedDelivery)) {
          return artifactMismatch('delivery');
        }
        return transition('act', 'bind-ready-head', 'READY_HEAD_DISCOVERED', {
          markerPatch: { phase: 'ready-head', headOid: facts.delivery.headOid },
        });
      }
    }
  } else if (!input.marker.headOid) {
    return artifactMismatch('terminal-marker');
  }

  const record = expectedPremergeRecord(input, deliveryBinding, !merged);
  if (!record) {
    return transition(
      'block',
      'invalid-premerge-record',
      'PREMERGE_RECORD_DRAFT_INVALID',
    );
  }
  const recordBody = serializePremergeRecord(record);
  const recordHash = premergeRecordHash(record);
  if (!completeExistence(facts.premergeRecord)) return inspect('premerge-record');
  if (facts.premergeRecord.exists !== true) {
    if (merged) return artifactMismatch('premerge-record');
    return transition('act', 'write-premerge-record', 'PREMERGE_RECORD_MISSING', {
      record,
      body: recordBody,
      bodyHash: recordHash,
    });
  }
  if (
    facts.premergeRecord.verified !== true ||
    facts.premergeRecord.headOid !== input.marker.headOid ||
    facts.premergeRecord.issue !== input.marker.issue ||
    facts.premergeRecord.pullRequest !== input.marker.pr ||
    facts.premergeRecord.id !== record.recordId ||
    facts.premergeRecord.bodyHash !== recordHash ||
    !HASH_RE.test(facts.premergeRecord.commentBodyHash ?? '') ||
    typeof facts.premergeRecord.commentId !== 'string' ||
    facts.premergeRecord.commentId.length === 0 ||
    stableJson(facts.premergeRecord.record) !== stableJson(record)
  ) {
    return artifactMismatch('premerge-record');
  }
  if (
    input.marker.premergeRecord
    && (
      input.marker.premergeRecord !== facts.premergeRecord.id
      || input.marker.premergeRecordHash !== facts.premergeRecord.bodyHash
      || input.marker.premergeRecordCommentId !== facts.premergeRecord.commentId
    )
  ) {
    return artifactMismatch('premerge-record');
  }
  if (!input.marker.premergeRecord) {
    return transition('act', 'bind-premerge-record', 'PREMERGE_RECORD_DISCOVERED', {
      markerPatch: {
        phase: 'premerge-record',
        premergeRecord: facts.premergeRecord.id,
        premergeRecordHash: facts.premergeRecord.bodyHash,
        premergeRecordCommentId: facts.premergeRecord.commentId,
      },
    });
  }
  if (restoreDelivery) {
    return transition('act', 'restore-delivered', 'DELIVERED_STATE_MISSING', {
      headOid: input.marker.headOid,
    });
  }

  const operation = input.marker.mergeOperation;
  if (
    operation
    && (
      operation.headOid !== input.marker.headOid
      || operation.premergeRecord !== input.marker.premergeRecord
    )
  ) {
    return artifactMismatch('merge-operation');
  }
  if (facts.merge?.complete !== true) return inspect('merge');
  if (facts.merge.merged === true) {
    if (
      facts.merge.headOid !== input.marker.headOid ||
      !SHA_RE.test(facts.merge.mergeOid ?? '')
    ) {
      return artifactMismatch('merge');
    }
    if (operation?.state === 'attempt') {
      return transition('act', 'record-merge-result', 'MERGE_RESULT_OBSERVED', {
        markerPatch: {
          phase: 'merge-result',
          mergeOperation: mergeOperation(input.marker, 'result'),
        },
      });
    }
    if (!completeExistence(facts.finalRecord)) return inspect('final-record');
    if (facts.finalRecord.exists !== true) {
      const outcome = createTerminalOutcome(record, facts.merge.mergeOid);
      return transition('act', 'append-merge-outcome', 'FINAL_RECORD_MISSING', {
        commentId: input.marker.premergeRecordCommentId,
        premergeRecord: input.marker.premergeRecord,
        premergeRecordHash: input.marker.premergeRecordHash,
        expectedCommentBodyHash: facts.premergeRecord.commentBodyHash,
        headOid: input.marker.headOid,
        mergeOid: facts.merge.mergeOid,
        outcome,
        terminalMarker: serializeTerminalOutcome(outcome, record),
      });
    }
    if (
      facts.finalRecord.verified !== true ||
      facts.finalRecord.premergeRecord !== input.marker.premergeRecord ||
      facts.finalRecord.premergeRecordHash !== input.marker.premergeRecordHash ||
      facts.finalRecord.commentId !== input.marker.premergeRecordCommentId ||
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
    const { mergeSubmitted: ignoredLegacyFlag, ...legacyMarker } = input.marker;
    return transition('block', 'park-merge-unknown', 'LEGACY_MERGE_OUTCOME_UNKNOWN', {
      marker: {
        ...legacyMarker,
        phase: 'merge-unknown',
        mergeOperation: mergeOperation(input.marker, 'unknown'),
      },
      terminal: 'human',
    });
  }
  if (!operation) {
    return transition('act', 'record-merge-intent', 'MERGE_INTENT_REQUIRED', {
      markerPatch: {
        phase: 'merge-intent',
        mergeOperation: mergeOperation(input.marker, 'intent'),
      },
    });
  }
  if (operation.state === 'intent') {
    return transition('act', 'submit-ratified-merge', 'MERGE_READY', {
      markerPatch: {
        phase: 'merge-attempt',
        mergeOperation: mergeOperation(input.marker, 'attempt'),
      },
      persistMarkerBeforeEffect: true,
    });
  }
  if (operation.state === 'attempt') {
    if (
      facts.mergeAttempt?.complete === true
      && !sameMergeOperation(operation, facts.mergeAttempt)
    ) {
      return artifactMismatch('merge-attempt');
    }
    const outcome = facts.mergeAttempt?.complete === true
      ? facts.mergeAttempt.state
      : 'unknown';
    if (outcome === 'result') {
      return transition('act', 'record-merge-result', 'MERGE_RESULT_OBSERVED', {
        markerPatch: {
          phase: 'merge-result',
          mergeOperation: mergeOperation(input.marker, 'result'),
        },
      });
    }
    const refused = outcome === 'refusal';
    return transition(
      'block',
      refused ? 'park-merge-refusal' : 'park-merge-unknown',
      refused ? 'STRICT_DIRECT_MERGE_REFUSED' : 'MERGE_OUTCOME_UNKNOWN',
      {
        markerPatch: {
          phase: refused ? 'merge-refusal' : 'merge-unknown',
          mergeOperation: mergeOperation(input.marker, refused ? 'refusal' : 'unknown'),
        },
        terminal: 'human',
      },
    );
  }
  if (operation.state === 'refusal') {
    return transition('block', 'park-merge-refusal', 'STRICT_DIRECT_MERGE_REFUSED', {
      terminal: 'human',
    });
  }
  if (operation.state === 'unknown') {
    return transition('block', 'park-merge-unknown', 'MERGE_OUTCOME_UNKNOWN', {
      terminal: 'human',
    });
  }
  if (operation.state === 'result') {
    return transition('block', 'park-merge-unknown', 'MERGE_RESULT_NOT_CONFIRMED', {
      markerPatch: {
        phase: 'merge-unknown',
        mergeOperation: mergeOperation(input.marker, 'unknown'),
      },
      terminal: 'human',
    });
  }
  return artifactMismatch('merge-operation');
}

let SHA = 'a'.repeat(40);
let OTHER_SHA = 'f'.repeat(40);
const PENDING_SHA = 'e'.repeat(40);
// Delivery-green (nothing triggered) but carrying NO verdict statuses — the
// bare-claim-head shape that must never discover a ready head.
const UNVERDICTED_SHA = 'd'.repeat(40);
const HASH = 'b'.repeat(64);
function testDeliveryEvidenceHash(headOid) {
  return headOid === OTHER_SHA ? '6'.repeat(64) : '5'.repeat(64);
}

function deliveryRequestFor(headOid, overrides = {}) {
  return {
    schemaVersion: 1,
    repository: 'owner/repository',
    pullRequest: 12,
    committedHead: headOid,
    reviewedHead: headOid,
    gatedHead: headOid,
    ...overrides,
  };
}

function deliveryRequest(overrides = {}) {
  return deliveryRequestFor(SHA, overrides);
}

function trustedTestFinalizer(request) {
  if (
    request.committedHead !== request.reviewedHead
    || request.reviewedHead !== request.gatedHead
    || request.gatedHead === PENDING_SHA
  ) {
    return {
      state: 'awaiting-ci',
      code: 'TEST_DELIVERY_NOT_GREEN',
      canMarkDelivered: false,
      headOid: request.gatedHead,
    };
  }
  return {
    state: 'delivered',
    code: 'CI_GREEN',
    canMarkDelivered: true,
    headOid: request.gatedHead,
    liveEvidence: {
      schemaVersion: 1,
      source: 'github-rest',
      repository: request.repository,
      pullRequest: request.pullRequest,
      remoteHead: request.gatedHead,
      statuses: request.gatedHead === UNVERDICTED_SHA
        ? []
        : [
            { context: 'agentic/gate', state: 'success', description: '' },
            { context: 'agentic/review', state: 'success', description: '' },
          ],
      provenance: {
        schemaVersion: 1,
        source: 'github-rest',
        repository: request.repository,
        pullRequest: request.pullRequest,
        evidenceFingerprint: testDeliveryEvidenceHash(request.gatedHead),
      },
    },
  };
}

function testReconcileContext() {
  return {
    [TRUSTED_TEST_FINALIZER]: trustedTestFinalizer,
  };
}

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
  return bindTestPremergeRecord({
    v: 1,
    ...intent(),
    phase: 'intent-recorded',
    ...overrides,
  });
}

function testPremergeRecord(markerValue) {
  if (
    !Number.isSafeInteger(markerValue?.pr)
    || !SHA_RE.test(markerValue?.headOid ?? '')
  ) {
    return null;
  }
  return createPremergeRecord({
    issue: markerValue.issue,
    pullRequest: markerValue.pr,
    headOid: markerValue.headOid,
    run: {
      intentHash: markerValue.runIntentHash,
      receiptFingerprint: '1'.repeat(64),
    },
    plan: {
      commentId: 'IC_plan',
      contentHash: markerValue.planHash,
    },
    review: {
      summaryHash: '2'.repeat(64),
    },
    gate: {
      summaryHash: '3'.repeat(64),
    },
    ci: {
      evidenceHash: testDeliveryEvidenceHash(markerValue.headOid),
    },
    lifecycle: {
      commentId: 'IC_lifecycle',
      identityHash: lifecycleIdentityHash(markerValue),
    },
  });
}

function bindTestPremergeRecord(markerValue) {
  if (markerValue.premergeRecord !== 'record-1') return markerValue;
  const record = testPremergeRecord(markerValue);
  if (!record) return markerValue;
  return {
    ...markerValue,
    premergeRecord: record.recordId,
    premergeRecordHash: premergeRecordHash(record),
    premergeRecordCommentId: 'IC_premerge',
    ...(markerValue.mergeOperation?.premergeRecord === 'record-1'
      ? {
        mergeOperation: {
          ...markerValue.mergeOperation,
          premergeRecord: record.recordId,
        },
      }
      : {}),
  };
}

function withTestPremergeDraft(input) {
  if (!input?.marker) return input;
  const record = input.premergeRecordDraft ?? testPremergeRecord(input.marker);
  if (!record) return input;
  const premergeRecord = input.observed?.premergeRecord;
  const finalRecord = input.observed?.finalRecord;
  const mergeAttempt = input.observed?.mergeAttempt;
  return {
    ...input,
    premergeRecordDraft: record,
    observed: {
      ...input.observed,
      ...(premergeRecord?.id === 'record-1'
        ? {
          premergeRecord: {
            ...testPremergeObservationFor(record),
            ...premergeRecord,
            id: record.recordId,
          },
        }
        : {}),
      ...(finalRecord?.premergeRecord === 'record-1'
        ? {
          finalRecord: {
            verified: true,
            premergeRecordHash: premergeRecordHash(record),
            commentId: 'IC_premerge',
            ...finalRecord,
            premergeRecord: record.recordId,
          },
        }
        : {}),
      ...(mergeAttempt?.premergeRecord === 'record-1'
        ? {
          mergeAttempt: {
            ...mergeAttempt,
            premergeRecord: record.recordId,
          },
        }
        : {}),
    },
  };
}

function testPremergeObservationFor(record, overrides = {}) {
  return {
    complete: true,
    exists: true,
    verified: true,
    id: record.recordId,
    bodyHash: premergeRecordHash(record),
    commentBodyHash: premergeRecordHash(record),
    commentId: 'IC_premerge',
    issue: record.issue,
    pullRequest: record.pullRequest,
    headOid: record.headOid,
    record,
    ...overrides,
  };
}

function testPremergeObservation(overrides = {}) {
  const record = testPremergeRecord(marker({
    claimCommit: SHA,
    pr: 12,
    headOid: SHA,
  }));
  return testPremergeObservationFor(record, overrides);
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

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function incrementEffect(world, name) {
  world.effects[name] = (world.effects[name] ?? 0) + 1;
}

function setMarker(world, result) {
  const next = result.marker
    ?? (result.markerPatch ? { ...world.marker, ...result.markerPatch } : world.marker);
  if (stableJson(next) !== stableJson(world.marker)) {
    world.marker = next;
    incrementEffect(world, 'marker');
  }
}

function setObserved(world, action, section, value) {
  if (stableJson(world.observed[section]) !== stableJson(value)) {
    world.observed[section] = value;
    incrementEffect(world, action);
  }
}

function applyRecoveryTransition(world, result) {
  if (result.action) {
    world.attempts[result.action] = (world.attempts[result.action] ?? 0) + 1;
  }
  setMarker(world, result);
  if (result.action === 'ensure-local-claim') {
    setObserved(world, result.action, 'localClaim', {
      complete: true,
      exists: true,
      branch: world.intent.branch,
      claimCommit: SHA,
    });
  } else if (result.action === 'ensure-remote-claim') {
    setObserved(world, result.action, 'remoteClaim', {
      complete: true,
      exists: true,
      branch: world.intent.branch,
      headOid: SHA,
      containsClaimCommit: true,
    });
  } else if (result.action === 'ensure-plan-comment') {
    setObserved(world, result.action, 'planComment', {
      complete: true,
      exists: true,
      planHash: world.intent.planHash,
    });
  } else if (result.action === 'ensure-draft-pr') {
    setObserved(world, result.action, 'draftPr', {
      complete: true,
      exists: true,
      number: 12,
      issue: world.intent.issue,
      branch: world.intent.branch,
    });
  } else if (result.action === 'resume-unit') {
    setObserved(world, result.action, 'delivery', {
      complete: true,
      exists: false,
      request: deliveryRequest(),
    });
  } else if (result.action === 'restore-delivered') {
    setObserved(world, result.action, 'delivery', {
      complete: true,
      exists: true,
      headOid: SHA,
      request: deliveryRequest(),
    });
  } else if (result.action === 'write-premerge-record') {
    setObserved(world, result.action, 'premergeRecord', {
      complete: true,
      exists: true,
      verified: true,
      id: result.record.recordId,
      bodyHash: result.bodyHash,
      commentBodyHash: result.bodyHash,
      commentId: 'IC_premerge',
      issue: result.record.issue,
      pullRequest: result.record.pullRequest,
      headOid: result.record.headOid,
      record: result.record,
    });
  } else if (result.action === 'submit-ratified-merge') {
    setObserved(world, 'merge', 'merge', {
      complete: true,
      merged: true,
      headOid: SHA,
      mergeOid: 'e'.repeat(40),
    });
  } else if (result.action === 'append-merge-outcome') {
    setObserved(world, 'final-record', 'finalRecord', {
      complete: true,
      exists: true,
      verified: true,
      premergeRecord: result.premergeRecord,
      premergeRecordHash: result.premergeRecordHash,
      commentId: result.commentId,
      headOid: result.headOid,
      mergeOid: result.mergeOid,
    });
  }
}

function reconcileFromDurableState(world) {
  const record = testPremergeRecord(world.marker);
  const input = cloneJson(withTestPremergeDraft({
    intent: world.intent,
    marker: world.marker,
    observed: world.observed,
    ...(record ? { premergeRecordDraft: record } : {}),
  }));
  const result = reconcileLifecycle(input, testReconcileContext());
  return { bytes: JSON.stringify(result), result };
}

function stableTerminalReplay(world, state, action) {
  const first = reconcileFromDurableState(world);
  const second = reconcileFromDurableState(world);
  return first.bytes === second.bytes
    && first.result.state === state
    && first.result.action === action;
}

function runCrashRecovery(seed, terminalWait = null) {
  let world = cloneJson(seed);
  for (let step = 0; step < 24; step += 1) {
    const first = reconcileFromDurableState(world);
    const replay = reconcileFromDurableState(world);
    if (first.bytes !== replay.bytes) {
      return { ok: false, reason: 'replay diverged', world };
    }
    applyRecoveryTransition(world, first.result);
    world = cloneJson(world);
    if (first.result.state === 'complete' || first.result.state === 'block') {
      return {
        ok: stableTerminalReplay(world, first.result.state, first.result.action),
        result: first.result,
        world,
      };
    }
    if (first.result.state === 'wait' && first.result.action === terminalWait) {
      return {
        ok: stableTerminalReplay(world, first.result.state, first.result.action),
        result: first.result,
        world,
      };
    }
    if (first.result.state === 'wait') {
      return { ok: false, reason: `unexpected wait ${first.result.action}`, world };
    }
  }
  return { ok: false, reason: 'recovery did not converge', world };
}

function crashMarker(phase) {
  const phases = [...PHASES];
  const value = marker({ mergePolicy: 'auto', phase });
  const reached = (candidate) => phases.indexOf(phase) >= phases.indexOf(candidate);
  if (reached('local-claim')) value.claimCommit = SHA;
  if (reached('draft-pr')) value.pr = 12;
  if (reached('ready-head')) value.headOid = SHA;
  if (reached('premerge-record')) {
    value.premergeRecord = 'record-1';
    Object.assign(value, bindTestPremergeRecord(value));
  }
  if (phase === 'merge-submitted') {
    value.mergeSubmitted = true;
  } else if (phase.startsWith('merge-')) {
    value.mergeOperation = mergeOperation(value, phase.slice('merge-'.length));
  }
  if (phase === 'terminal-record') value.mergeOid = 'e'.repeat(40);
  return value;
}

function crashWorld(phase) {
  const phases = [...PHASES];
  const reached = (candidate) => phases.indexOf(phase) >= phases.indexOf(candidate);
  const durableMarker = crashMarker(phase);
  const facts = observed({
    localClaim: { complete: true, exists: false },
    remoteClaim: { complete: true, exists: false },
    planComment: { complete: true, exists: false },
    draftPr: { complete: true, exists: false },
    delivery: { complete: true, exists: false },
    premergeRecord: { complete: true, exists: false },
  });
  if (reached('local-claim')) {
    facts.localClaim = {
      complete: true,
      exists: true,
      branch: 'feat/gh-7-contract',
      claimCommit: SHA,
    };
  }
  if (reached('remote-claim')) {
    facts.remoteClaim = {
      complete: true,
      exists: true,
      branch: 'feat/gh-7-contract',
      headOid: SHA,
      containsClaimCommit: true,
    };
  }
  if (reached('plan-comment')) {
    facts.planComment = { complete: true, exists: true, planHash: 'c'.repeat(64) };
  }
  if (reached('draft-pr')) {
    facts.draftPr = {
      complete: true,
      exists: true,
      number: 12,
      issue: 7,
      branch: 'feat/gh-7-contract',
    };
  }
  if (reached('ready-head')) {
    facts.delivery = {
      complete: true,
      exists: false,
      request: deliveryRequest(),
    };
  }
  if (reached('merge-intent')) {
    facts.delivery = {
      complete: true,
      exists: true,
      headOid: SHA,
      request: deliveryRequest(),
    };
  }
  if (reached('premerge-record')) {
    facts.premergeRecord = testPremergeObservationFor(
      testPremergeRecord(durableMarker),
    );
  }
  if (phase === 'merge-result' || phase === 'terminal-record') {
    facts.merge = {
      complete: true,
      merged: true,
      headOid: SHA,
      mergeOid: 'e'.repeat(40),
    };
  }
  if (phase === 'terminal-record') {
    facts.finalRecord = {
      complete: true,
      exists: true,
      verified: true,
      premergeRecord: facts.premergeRecord.id,
      premergeRecordHash: facts.premergeRecord.bodyHash,
      commentId: facts.premergeRecord.commentId,
      headOid: SHA,
      mergeOid: 'e'.repeat(40),
    };
  }
  return {
    intent: { ...intent(), mergePolicy: 'auto' },
    marker: durableMarker,
    observed: facts,
    effects: {},
    attempts: {},
  };
}

function crashRecoveryChecks() {
  const humanTerminal = new Map([
    ['merge-attempt', 'park-merge-unknown'],
    ['merge-refusal', 'park-merge-refusal'],
    ['merge-unknown', 'park-merge-unknown'],
    ['merge-submitted', 'park-merge-unknown'],
  ]);
  const checks = [];
  const covered = new Set();
  for (const phase of PHASES) {
    try {
      const recovery = runCrashRecovery(crashWorld(phase));
      const expectedAction = humanTerminal.get(phase) ?? null;
      const counts = Object.entries(recovery.world.effects)
        .filter(([name]) => name !== 'marker')
        .map(([, count]) => count);
      const attempts = Object.values(recovery.world.attempts);
      checks.push([
        `crash restart from ${phase} is idempotent`,
        recovery.ok
          && recovery.result.state === (expectedAction ? 'block' : 'complete')
          && recovery.result.action === expectedAction
          && counts.every((count) => count === 1)
          && attempts.every((count) => count === 1),
      ]);
      covered.add(phase);
    } catch (error) {
      console.error(`FAIL crash restart from ${phase}: ${error.message}`);
      checks.push([`crash restart from ${phase} is idempotent`, false]);
    }
  }
  try {
    const postEffect = crashWorld('merge-attempt');
    postEffect.observed.merge = {
      complete: true,
      merged: true,
      headOid: SHA,
      mergeOid: 'e'.repeat(40),
    };
    const recovery = runCrashRecovery(postEffect);
    checks.push([
      'crash after merge effect converges without resubmission',
      recovery.ok
        && recovery.result.state === 'complete'
        && (recovery.world.effects.merge ?? 0) === 0
        && recovery.world.effects['final-record'] === 1,
    ]);
  } catch (error) {
    console.error(`FAIL crash after merge effect: ${error.message}`);
    checks.push(['crash after merge effect converges without resubmission', false]);
  }
  try {
    const mergedWithoutFinal = crashWorld('premerge-record');
    mergedWithoutFinal.observed.merge = {
      complete: true,
      merged: true,
      headOid: SHA,
      mergeOid: 'e'.repeat(40),
    };
    const recovery = runCrashRecovery(mergedWithoutFinal);
    checks.push([
      'merged without final record is backfilled once',
      recovery.ok
        && recovery.result.state === 'complete'
        && recovery.world.effects['final-record'] === 1,
    ]);
  } catch (error) {
    console.error(`FAIL merged without final record: ${error.message}`);
    checks.push(['merged without final record is backfilled once', false]);
  }
  try {
    const manual = crashWorld('ready-head');
    manual.intent.mergePolicy = 'manual';
    manual.marker.mergePolicy = 'manual';
    manual.observed.delivery = {
      complete: true,
      exists: false,
      request: deliveryRequest(),
    };
    const recovery = runCrashRecovery(manual, 'await-human-merge');
    checks.push([
      'manual delivery signal follows durable premerge evidence',
      recovery.ok
        && recovery.result.state === 'wait'
        && recovery.world.effects['write-premerge-record'] === 1
        && recovery.world.effects['restore-delivered'] === 1
        && Object.keys(recovery.world.attempts).join(',')
          === [
            'write-premerge-record',
            'bind-premerge-record',
            'restore-delivered',
            'await-human-merge',
          ].join(','),
    ]);
  } catch (error) {
    console.error(`FAIL manual premerge ordering: ${error.message}`);
    checks.push(['manual delivery signal follows durable premerge evidence', false]);
  }
  try {
    const recovery = runCrashRecovery(crashWorld('draft-pr'));
    checks.push([
      'draft restart reaches ready head before premerge and delivery',
      recovery.ok
        && recovery.result.state === 'complete'
        && Object.keys(recovery.world.attempts).join(',')
          === [
            'resume-unit',
            'bind-ready-head',
            'write-premerge-record',
            'bind-premerge-record',
            'restore-delivered',
            'record-merge-intent',
            'submit-ratified-merge',
            'record-merge-result',
            'append-merge-outcome',
          ].join(','),
    ]);
  } catch (error) {
    console.error(`FAIL draft-to-terminal crash recovery: ${error.message}`);
    checks.push(['draft restart reaches ready head before premerge and delivery', false]);
  }
  try {
    // The wedge that stranded two live units: a ready-head marker whose bound
    // head was superseded by a claim-chain push. Recovery must unbind, resume,
    // and re-earn ready-head on the current head — never block on identity.
    const superseded = crashWorld('ready-head');
    superseded.marker.headOid = OTHER_SHA;
    const recovery = runCrashRecovery(superseded);
    checks.push([
      'a superseded ready-head unbinds and re-converges to terminal',
      recovery.ok
        && recovery.result.state === 'complete'
        && recovery.world.attempts['unbind-ready-head'] === 1
        && Object.keys(recovery.world.attempts).slice(0, 2).join(',')
          === 'unbind-ready-head,bind-ready-head',
    ]);
  } catch (error) {
    console.error(`FAIL superseded ready-head recovery: ${error.message}`);
    checks.push(['a superseded ready-head unbinds and re-converges to terminal', false]);
  }
  try {
    const manualMerged = crashWorld('ready-head');
    manualMerged.intent.mergePolicy = 'manual';
    manualMerged.marker.mergePolicy = 'manual';
    manualMerged.observed.premergeRecord = {
      complete: true,
      exists: true,
      id: 'record-1',
      headOid: SHA,
    };
    manualMerged.observed.merge = {
      complete: true,
      merged: true,
      headOid: SHA,
      mergeOid: 'e'.repeat(40),
    };
    const recovery = runCrashRecovery(manualMerged);
    checks.push([
      'manual premerge effect ahead of its marker survives a later merge',
      recovery.ok
        && recovery.result.state === 'complete'
        && recovery.world.effects['final-record'] === 1
        && validPremergeRecordId(recovery.world.observed.finalRecord.premergeRecord),
    ]);
  } catch (error) {
    console.error(`FAIL manual effect-ahead merge recovery: ${error.message}`);
    checks.push(['manual premerge effect ahead of its marker survives a later merge', false]);
  }
  checks.push([
    'crash injection covers every lifecycle phase',
    covered.size === PHASES.size && [...PHASES].every((phase) => covered.has(phase)),
  ]);
  return checks;
}

function revisionRequest(markerValue, overrides = {}) {
  return {
    expectedEpoch: markerValue.epoch ?? 1,
    expectedHeadOid: markerValue.headOid,
    expectedIdentityHash: lifecycleIdentityHash(markerValue),
    expectedPlanCommentId: markerValue.planCommentId,
    expectedPremergeRecord: markerValue.premergeRecord,
    expectedPremergeRecordCommentId: markerValue.premergeRecordCommentId,
    expectedPremergeRecordHash: markerValue.premergeRecordHash,
    planCommentId: 'IC_plan_revision_2',
    planHash: '8'.repeat(64),
    plannedBaseOid: '9'.repeat(40),
    runIntentHash: '7'.repeat(64),
    selector: 'codex',
    ...overrides,
  };
}

function revisionChecks() {
  const deliveredA = marker({
    epoch: 1,
    phase: 'premerge-record',
    claimCommit: SHA,
    pr: 12,
    planCommentId: 'IC_plan',
    headOid: SHA,
    premergeRecord: 'record-1',
  });
  const requestB = revisionRequest(deliveredA);
  const staged = beginLifecycleRevision(deliveredA, requestB);
  const replay = beginLifecycleRevision(staged.marker, requestB);
  const advanced = advanceLifecycleRevision(staged.marker, {
    complete: true,
    headOid: SHA,
    labels: ['loop:revising'],
    planComment: {
      complete: true,
      id: requestB.planCommentId,
      bodyHash: requestB.planHash,
    },
  });
  const priorA = advanced.marker?.priorRevisions?.[0];
  const staleHead = advanceLifecycleRevision(staged.marker, {
    complete: true,
    headOid: OTHER_SHA,
    labels: ['loop:revising'],
    planComment: {
      complete: true,
      id: requestB.planCommentId,
      bodyHash: requestB.planHash,
    },
  });
  const wrongLabel = advanceLifecycleRevision(staged.marker, {
    complete: true,
    headOid: SHA,
    labels: ['loop-delivered', 'loop:revising'],
    planComment: {
      complete: true,
      id: requestB.planCommentId,
      bodyHash: requestB.planHash,
    },
  });
  const conflict = beginLifecycleRevision(staged.marker, {
    ...requestB,
    planHash: '6'.repeat(64),
  });
  const idempotent = beginLifecycleRevision(advanced.marker, requestB);
  const nonterminal = beginLifecycleRevision({
    ...deliveredA,
    phase: 'ready-head',
    premergeRecord: undefined,
    premergeRecordHash: undefined,
    premergeRecordCommentId: undefined,
  }, {
    ...requestB,
    expectedPremergeRecord: deliveredA.premergeRecord,
    expectedPremergeRecordHash: deliveredA.premergeRecordHash,
  });
  const deliveredBBase = {
    ...advanced.marker,
    phase: 'premerge-record',
    headOid: OTHER_SHA,
  };
  const recordB = testPremergeRecord(deliveredBBase);
  const deliveredB = {
    ...deliveredBBase,
    premergeRecord: recordB.recordId,
    premergeRecordHash: premergeRecordHash(recordB),
    premergeRecordCommentId: 'IC_premerge_B',
  };
  const requestC = revisionRequest(deliveredB, {
    planCommentId: 'IC_plan_revision_3',
    planHash: '5'.repeat(64),
    plannedBaseOid: '4'.repeat(40),
    runIntentHash: '3'.repeat(64),
    selector: 'opencode',
  });
  const stagedC = beginLifecycleRevision(deliveredB, requestC);
  const advancedC = advanceLifecycleRevision(stagedC.marker, {
    complete: true,
    headOid: OTHER_SHA,
    labels: ['loop:revising'],
    planComment: {
      complete: true,
      id: requestC.planCommentId,
      bodyHash: requestC.planHash,
    },
  });
  const supersededReplay = beginLifecycleRevision(advancedC.marker, requestB);
  return [
    [
      'delivered head stages one immutable revision intent',
      staged.state === 'act'
        && staged.action === 'stage-revision-intent'
        && staged.marker.revisionIntent.fromHeadOid === SHA
        && replay.state === 'wait',
    ],
    [
      'revision readback advances one epoch and preserves prior audit',
      advanced.state === 'act'
        && advanced.action === 'begin-revision-epoch'
        && advanced.marker.epoch === 2
        && advanced.marker.phase === 'draft-pr'
        && advanced.marker.headOid === undefined
        && advanced.marker.premergeRecord === undefined
        && advanced.marker.premergeRecordHash === undefined
        && advanced.marker.premergeRecordCommentId === undefined
        && priorA.headOid === SHA
        && priorA.premergeRecord === deliveredA.premergeRecord
        && priorA.premergeRecordCommentId
          === deliveredA.premergeRecordCommentId
        && priorA.identityHash === lifecycleIdentityHash(deliveredA),
    ],
    [
      'revision head or label races fail closed',
      staleHead.state === 'block'
        && staleHead.action === 'revision-race'
        && wrongLabel.state === 'block'
        && wrongLabel.action === 'revision-race',
    ],
    [
      'a different staged revision cannot supersede the durable intent',
      conflict.state === 'block'
        && conflict.code === 'REVISION_INTENT_CONFLICT',
    ],
    [
      'revision replay after epoch advance is idempotent',
      idempotent.state === 'complete'
        && idempotent.code === 'REVISION_ALREADY_BEGUN',
    ],
    [
      'nonterminal heads cannot begin Pitcrew revision',
      nonterminal.state === 'block'
        && nonterminal.code === 'REVISION_SOURCE_MISMATCH',
    ],
    [
      'successive revisions retain ordered immutable audits',
      stagedC.state === 'act'
        && advancedC.state === 'act'
        && advancedC.marker.epoch === 3
        && advancedC.marker.priorRevisions.length === 2
        && advancedC.marker.priorRevisions[0].headOid === SHA
        && advancedC.marker.priorRevisions[1].headOid === OTHER_SHA
        && parseLifecycleMarker(
          serializeLifecycleMarker(advancedC.marker),
        ).ok,
    ],
    [
      'a superseded prior revision cannot authorize the current epoch',
      supersededReplay.state === 'block'
        && supersededReplay.code === 'REVISION_SOURCE_MISMATCH',
    ],
  ];
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
      name: 'absent claim containment evidence is incomplete',
      input: {
        intent: intent(),
        marker: marker({ claimCommit: SHA }),
        observed: observed({
          remoteClaim: { complete: true, exists: true, branch: 'feat/gh-7-contract', headOid: SHA },
        }),
      },
      expected: ['wait', 'inspect-remote-claim'],
    },
    {
      name: 'remote identity mismatch outranks absent containment evidence',
      input: {
        intent: intent(),
        marker: marker({ claimCommit: SHA }),
        observed: observed({
          remoteClaim: { complete: true, exists: true, branch: 'feat/gh-8-contract', headOid: SHA },
        }),
      },
      expected: ['block', 'identity-mismatch'],
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
      name: 'finalized head is bound before premerge evidence and delivery',
      input: {
        intent: intent(),
        marker: marker({ claimCommit: SHA, pr: 12 }),
        observed: observed({
          delivery: { complete: true, exists: false, request: deliveryRequest() },
        }),
      },
      expected: ['act', 'bind-ready-head'],
    },
    {
      name: 'a green head without verdict statuses resumes, never binds ready-head',
      input: {
        intent: intent(),
        marker: marker({ claimCommit: SHA, pr: 12 }),
        observed: observed({
          remoteClaim: {
            complete: true,
            exists: true,
            branch: 'feat/gh-7-contract',
            headOid: UNVERDICTED_SHA,
            containsClaimCommit: true,
          },
          delivery: {
            complete: true,
            exists: false,
            request: deliveryRequestFor(UNVERDICTED_SHA),
          },
        }),
      },
      expected: ['resume', 'resume-unit'],
    },
    {
      name: 'a superseded ready-head unbinds to draft-pr instead of wedging',
      input: {
        intent: intent(),
        marker: marker({
          claimCommit: SHA,
          pr: 12,
          headOid: SHA,
          phase: 'ready-head',
        }),
        observed: observed({
          remoteClaim: {
            complete: true,
            exists: true,
            branch: 'feat/gh-7-contract',
            headOid: OTHER_SHA,
            containsClaimCommit: true,
          },
          delivery: {
            complete: true,
            exists: false,
            request: deliveryRequestFor(OTHER_SHA),
          },
        }),
      },
      expected: ['act', 'unbind-ready-head'],
    },
    {
      name: 'a delivered label without verdict statuses is an identity mismatch',
      input: {
        intent: intent(),
        marker: marker({ claimCommit: SHA, pr: 12 }),
        observed: observed({
          remoteClaim: {
            complete: true,
            exists: true,
            branch: 'feat/gh-7-contract',
            headOid: UNVERDICTED_SHA,
            containsClaimCommit: true,
          },
          delivery: {
            complete: true,
            exists: true,
            headOid: UNVERDICTED_SHA,
            request: deliveryRequestFor(UNVERDICTED_SHA),
          },
        }),
      },
      expected: ['block', 'identity-mismatch'],
    },
    {
      name: 'delivered head is bound before terminal record',
      input: {
        intent: intent(),
        marker: marker({ claimCommit: SHA, pr: 12 }),
        observed: observed({
          delivery: { complete: true, exists: true, headOid: SHA, request: deliveryRequest() },
        }),
      },
      expected: ['act', 'bind-ready-head'],
    },
    {
      name: 'delivered head without finalization evidence is incomplete',
      input: {
        intent: intent(),
        marker: marker({ claimCommit: SHA, pr: 12 }),
        observed: observed({ delivery: { complete: true, exists: true, headOid: SHA } }),
      },
      expected: ['wait', 'inspect-delivery'],
    },
    {
      name: 'premerge evidence precedes restoration of a missing delivered label',
      input: {
        intent: intent(),
        marker: marker({ claimCommit: SHA, pr: 12, headOid: SHA }),
        observed: observed({
          delivery: { complete: true, exists: false, request: deliveryRequest() },
        }),
      },
      expected: ['act', 'write-premerge-record'],
    },
    {
      name: 'bound premerge evidence restores a missing delivered label',
      input: {
        intent: intent(),
        marker: marker({
          claimCommit: SHA,
          pr: 12,
          headOid: SHA,
          premergeRecord: 'record-1',
        }),
        observed: observed({
          delivery: { complete: true, exists: false, request: deliveryRequest() },
          premergeRecord: { complete: true, exists: true, id: 'record-1', headOid: SHA },
        }),
      },
      expected: ['act', 'restore-delivered'],
    },
    {
      name: 'missing finalization evidence cannot restore delivered',
      input: {
        intent: intent(),
        marker: marker({ claimCommit: SHA, pr: 12, headOid: SHA }),
        observed: observed(),
      },
      expected: ['wait', 'inspect-delivery'],
    },
    {
      name: 'non-green live delivery cannot restore delivered',
      input: {
        intent: intent(),
        marker: marker({ claimCommit: SHA, pr: 12, headOid: SHA }),
        observed: observed({
          delivery: {
            complete: true,
            exists: false,
            request: deliveryRequestFor(PENDING_SHA),
          },
        }),
      },
      expected: ['wait', 'inspect-delivery'],
    },
    {
      name: 'stale finalized head cannot restore delivered',
      input: {
        intent: intent(),
        marker: marker({ claimCommit: SHA, pr: 12, headOid: SHA }),
        observed: observed({
          delivery: {
            complete: true,
            exists: false,
            request: deliveryRequestFor(OTHER_SHA),
          },
        }),
      },
      expected: ['block', 'identity-mismatch'],
    },
    {
      name: 'advanced remote head cannot restore delivered',
      input: {
        intent: intent(),
        marker: marker({ claimCommit: SHA, pr: 12, headOid: SHA }),
        observed: observed({
          remoteClaim: {
            complete: true,
            exists: true,
            branch: 'feat/gh-7-contract',
            headOid: OTHER_SHA,
            containsClaimCommit: true,
          },
          delivery: {
            complete: true,
            exists: false,
            request: deliveryRequestFor(OTHER_SHA),
          },
        }),
      },
      expected: ['block', 'identity-mismatch'],
    },
    {
      name: 'premerge evidence precedes merge',
      input: {
        intent: { ...intent(), mergePolicy: 'auto' },
        marker: marker({ mergePolicy: 'auto', claimCommit: SHA, pr: 12, headOid: SHA }),
        observed: observed({
          delivery: { complete: true, exists: true, headOid: SHA, request: deliveryRequest() },
        }),
      },
      expected: ['act', 'write-premerge-record'],
    },
    {
      name: 'recovered premerge record is bound before merge',
      input: {
        intent: { ...intent(), mergePolicy: 'auto' },
        marker: marker({ mergePolicy: 'auto', claimCommit: SHA, pr: 12, headOid: SHA }),
        observed: observed({
          delivery: { complete: true, exists: true, headOid: SHA, request: deliveryRequest() },
          premergeRecord: { complete: true, exists: true, id: 'record-1', headOid: SHA },
        }),
      },
      expected: ['act', 'bind-premerge-record'],
    },
    {
      name: 'manual recovery binds a premerge effect before waiting',
      input: {
        intent: intent(),
        marker: marker({ claimCommit: SHA, pr: 12, headOid: SHA }),
        observed: observed({
          delivery: { complete: true, exists: true, headOid: SHA, request: deliveryRequest() },
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
          delivery: { complete: true, exists: true, headOid: SHA, request: deliveryRequest() },
          premergeRecord: { complete: true, exists: true, id: 'record-1', headOid: SHA },
        }),
      },
      expected: ['wait', 'await-human-merge'],
    },
    {
      name: 'non-manual policy records strict-direct intent before submission',
      input: {
        intent: { ...intent(), mergePolicy: 'ratified' },
        marker: marker({ mergePolicy: 'ratified', claimCommit: SHA, pr: 12, headOid: SHA, premergeRecord: 'record-1' }),
        observed: observed({
          delivery: { complete: true, exists: true, headOid: SHA, request: deliveryRequest() },
          premergeRecord: { complete: true, exists: true, id: 'record-1', headOid: SHA },
        }),
      },
      expected: ['act', 'record-merge-intent'],
    },
    {
      name: 'recorded intent can safely begin one strict-direct attempt',
      input: {
        intent: { ...intent(), mergePolicy: 'auto' },
        marker: marker({
          mergePolicy: 'auto',
          claimCommit: SHA,
          pr: 12,
          headOid: SHA,
          premergeRecord: 'record-1',
          phase: 'merge-intent',
          mergeOperation: {
            kind: 'strict-direct',
            state: 'intent',
            headOid: SHA,
            premergeRecord: 'record-1',
          },
        }),
        observed: observed({
          delivery: { complete: true, exists: true, headOid: SHA, request: deliveryRequest() },
          premergeRecord: { complete: true, exists: true, id: 'record-1', headOid: SHA },
        }),
      },
      expected: ['act', 'submit-ratified-merge'],
    },
    {
      name: 'crash after attempt starts parks an unknown outcome for a human',
      input: {
        intent: { ...intent(), mergePolicy: 'auto' },
        marker: marker({
          mergePolicy: 'auto',
          claimCommit: SHA,
          pr: 12,
          headOid: SHA,
          premergeRecord: 'record-1',
          phase: 'merge-attempt',
          mergeOperation: {
            kind: 'strict-direct',
            state: 'attempt',
            headOid: SHA,
            premergeRecord: 'record-1',
          },
        }),
        observed: observed({
          delivery: { complete: true, exists: true, headOid: SHA, request: deliveryRequest() },
          premergeRecord: { complete: true, exists: true, id: 'record-1', headOid: SHA },
        }),
      },
      expected: ['block', 'park-merge-unknown'],
    },
    {
      name: 'definitive strict-direct refusal parks human-terminal',
      input: {
        intent: { ...intent(), mergePolicy: 'auto' },
        marker: marker({
          mergePolicy: 'auto',
          claimCommit: SHA,
          pr: 12,
          headOid: SHA,
          premergeRecord: 'record-1',
          phase: 'merge-attempt',
          mergeOperation: {
            kind: 'strict-direct',
            state: 'attempt',
            headOid: SHA,
            premergeRecord: 'record-1',
          },
        }),
        observed: observed({
          delivery: { complete: true, exists: true, headOid: SHA, request: deliveryRequest() },
          premergeRecord: { complete: true, exists: true, id: 'record-1', headOid: SHA },
          mergeAttempt: {
            complete: true,
            kind: 'strict-direct',
            state: 'refusal',
            headOid: SHA,
            premergeRecord: 'record-1',
          },
        }),
      },
      expected: ['block', 'park-merge-refusal'],
    },
    {
      name: 'legacy submitted boolean is recovered as unknown instead of waiting forever',
      input: {
        intent: { ...intent(), mergePolicy: 'auto' },
        marker: marker({
          mergePolicy: 'auto',
          claimCommit: SHA,
          pr: 12,
          headOid: SHA,
          premergeRecord: 'record-1',
          phase: 'merge-submitted',
          mergeSubmitted: true,
        }),
        observed: observed({
          delivery: { complete: true, exists: true, headOid: SHA, request: deliveryRequest() },
          premergeRecord: { complete: true, exists: true, id: 'record-1', headOid: SHA },
        }),
      },
      expected: ['block', 'park-merge-unknown'],
    },
    {
      name: 'live merge after an attempt persists a typed result before terminal audit',
      input: {
        intent: { ...intent(), mergePolicy: 'auto' },
        marker: marker({
          mergePolicy: 'auto',
          claimCommit: SHA,
          pr: 12,
          headOid: SHA,
          premergeRecord: 'record-1',
          phase: 'merge-attempt',
          mergeOperation: {
            kind: 'strict-direct',
            state: 'attempt',
            headOid: SHA,
            premergeRecord: 'record-1',
          },
        }),
        observed: observed({
          delivery: { complete: true, exists: true, headOid: SHA, request: deliveryRequest() },
          premergeRecord: { complete: true, exists: true, id: 'record-1', headOid: SHA },
          merge: { complete: true, merged: true, headOid: SHA, mergeOid: 'e'.repeat(40) },
        }),
      },
      expected: ['act', 'record-merge-result'],
    },
    {
      name: 'typed result proceeds to the terminal audit record',
      input: {
        intent: { ...intent(), mergePolicy: 'auto' },
        marker: marker({
          mergePolicy: 'auto',
          claimCommit: SHA,
          pr: 12,
          headOid: SHA,
          premergeRecord: 'record-1',
          phase: 'merge-result',
          mergeOperation: {
            kind: 'strict-direct',
            state: 'result',
            headOid: SHA,
            premergeRecord: 'record-1',
          },
        }),
        observed: observed({
          delivery: { complete: true, exists: true, headOid: SHA, request: deliveryRequest() },
          premergeRecord: { complete: true, exists: true, id: 'record-1', headOid: SHA },
          merge: { complete: true, merged: true, headOid: SHA, mergeOid: 'e'.repeat(40) },
        }),
      },
      expected: ['act', 'append-merge-outcome'],
    },
    {
      name: 'unconfirmed typed result becomes unknown and parks human-terminal',
      input: {
        intent: { ...intent(), mergePolicy: 'auto' },
        marker: marker({
          mergePolicy: 'auto',
          claimCommit: SHA,
          pr: 12,
          headOid: SHA,
          premergeRecord: 'record-1',
          phase: 'merge-result',
          mergeOperation: {
            kind: 'strict-direct',
            state: 'result',
            headOid: SHA,
            premergeRecord: 'record-1',
          },
        }),
        observed: observed({
          delivery: { complete: true, exists: true, headOid: SHA, request: deliveryRequest() },
          premergeRecord: { complete: true, exists: true, id: 'record-1', headOid: SHA },
        }),
      },
      expected: ['block', 'park-merge-unknown'],
    },
    {
      name: 'merged without outcome backfills final record',
      input: {
        intent: { ...intent(), mergePolicy: 'auto' },
        marker: marker({ mergePolicy: 'auto', claimCommit: SHA, pr: 12, headOid: SHA, premergeRecord: 'record-1' }),
        observed: observed({
          delivery: { complete: true, exists: true, headOid: SHA, request: deliveryRequest() },
          premergeRecord: { complete: true, exists: true, id: 'record-1', headOid: SHA },
          merge: { complete: true, merged: true, headOid: SHA, mergeOid: 'e'.repeat(40) },
        }),
      },
      expected: ['act', 'append-merge-outcome'],
    },
    {
      name: 'merged recovery does not recreate an auto-deleted remote claim',
      input: {
        intent: { ...intent(), mergePolicy: 'auto' },
        marker: marker({ mergePolicy: 'auto', claimCommit: SHA, pr: 12, headOid: SHA, premergeRecord: 'record-1' }),
        observed: observed({
          remoteClaim: { complete: true, exists: false },
          delivery: { complete: true, exists: true, headOid: SHA, request: deliveryRequest() },
          premergeRecord: { complete: true, exists: true, id: 'record-1', headOid: SHA },
          merge: { complete: true, merged: true, headOid: SHA, mergeOid: 'e'.repeat(40) },
        }),
      },
      expected: ['act', 'append-merge-outcome'],
    },
    {
      name: 'merged recovery does not recreate a deleted local claim',
      input: {
        intent: { ...intent(), mergePolicy: 'auto' },
        marker: marker({ mergePolicy: 'auto', claimCommit: SHA, pr: 12, headOid: SHA, premergeRecord: 'record-1' }),
        observed: observed({
          localClaim: { complete: true, exists: false },
          delivery: { complete: true, exists: true, headOid: SHA, request: deliveryRequest() },
          premergeRecord: { complete: true, exists: true, id: 'record-1', headOid: SHA },
          merge: { complete: true, merged: true, headOid: SHA, mergeOid: 'e'.repeat(40) },
        }),
      },
      expected: ['act', 'append-merge-outcome'],
    },
    {
      name: 'merged recovery binds a premerge effect that preceded its marker',
      input: {
        intent: intent(),
        marker: marker({ claimCommit: SHA, pr: 12, headOid: SHA }),
        observed: observed({
          delivery: { complete: true, exists: true, headOid: SHA, request: deliveryRequest() },
          premergeRecord: { complete: true, exists: true, id: 'record-1', headOid: SHA },
          merge: { complete: true, merged: true, headOid: SHA, mergeOid: 'e'.repeat(40) },
        }),
      },
      expected: ['act', 'bind-premerge-record'],
    },
    {
      name: 'merged recovery cannot bind a missing head from caller delivery fields',
      input: {
        intent: intent(),
        marker: marker({ claimCommit: SHA, pr: 12 }),
        observed: observed({
          delivery: { complete: true, exists: true, headOid: SHA, request: deliveryRequest() },
          premergeRecord: { complete: true, exists: true, id: 'record-1', headOid: SHA },
          merge: { complete: true, merged: true, headOid: SHA, mergeOid: 'e'.repeat(40) },
        }),
      },
      expected: ['block', 'identity-mismatch'],
    },
    {
      name: 'effect-ahead premerge recovery inspects an incomplete merge before ref repair',
      input: {
        intent: intent(),
        marker: marker({ claimCommit: SHA, pr: 12, headOid: SHA }),
        observed: observed({
          localClaim: { complete: true, exists: false },
          premergeRecord: { complete: true, exists: true, id: 'record-1', headOid: SHA },
          merge: { complete: false },
        }),
      },
      expected: ['wait', 'inspect-merge'],
    },
    {
      name: 'terminal recovery inspects merge before repairing a missing claim',
      input: {
        intent: { ...intent(), mergePolicy: 'auto' },
        marker: marker({ mergePolicy: 'auto', claimCommit: SHA, pr: 12, headOid: SHA, premergeRecord: 'record-1' }),
        observed: observed({
          localClaim: { complete: true, exists: false },
          merge: { complete: false },
        }),
      },
      expected: ['wait', 'inspect-merge'],
    },
    {
      name: 'malformed complete merge evidence never repairs a missing claim',
      input: {
        intent: { ...intent(), mergePolicy: 'auto' },
        marker: marker({ mergePolicy: 'auto', claimCommit: SHA, pr: 12, headOid: SHA, premergeRecord: 'record-1' }),
        observed: observed({
          localClaim: { complete: true, exists: false },
          merge: { complete: true, merged: null },
        }),
      },
      expected: ['block', 'identity-mismatch'],
    },
    {
      name: 'unknown local claim existence is not treated as deletion',
      input: {
        intent: { ...intent(), mergePolicy: 'auto' },
        marker: marker({ mergePolicy: 'auto', claimCommit: SHA, pr: 12, headOid: SHA, premergeRecord: 'record-1' }),
        observed: observed({
          localClaim: { complete: true, exists: null },
          merge: { complete: true, merged: true, headOid: SHA, mergeOid: 'e'.repeat(40) },
        }),
      },
      expected: ['wait', 'inspect-local-claim'],
    },
    {
      name: 'unknown remote claim existence is not treated as deletion',
      input: {
        intent: { ...intent(), mergePolicy: 'auto' },
        marker: marker({ mergePolicy: 'auto', claimCommit: SHA, pr: 12, headOid: SHA, premergeRecord: 'record-1' }),
        observed: observed({
          remoteClaim: { complete: true, exists: null },
          merge: { complete: true, merged: true, headOid: SHA, mergeOid: 'e'.repeat(40) },
        }),
      },
      expected: ['wait', 'inspect-remote-claim'],
    },
    {
      name: 'terminal recovery waits for complete remote absence evidence',
      input: {
        intent: { ...intent(), mergePolicy: 'auto' },
        marker: marker({ mergePolicy: 'auto', claimCommit: SHA, pr: 12, headOid: SHA, premergeRecord: 'record-1' }),
        observed: observed({
          remoteClaim: { complete: false },
          merge: { complete: true, merged: true, headOid: SHA, mergeOid: 'e'.repeat(40) },
        }),
      },
      expected: ['wait', 'inspect-remote-claim'],
    },
    {
      name: 'surviving remote claim must match the merged head',
      input: {
        intent: { ...intent(), mergePolicy: 'auto' },
        marker: marker({ mergePolicy: 'auto', claimCommit: SHA, pr: 12, headOid: SHA, premergeRecord: 'record-1' }),
        observed: observed({
          remoteClaim: {
            complete: true,
            exists: true,
            branch: 'feat/gh-7-contract',
            headOid: OTHER_SHA,
            containsClaimCommit: true,
          },
          premergeRecord: { complete: true, exists: true, id: 'record-1', headOid: SHA },
          merge: { complete: true, merged: true, headOid: SHA, mergeOid: 'e'.repeat(40) },
        }),
      },
      expected: ['block', 'identity-mismatch'],
    },
    {
      name: 'merged recovery never recreates a missing delivered label',
      input: {
        intent: { ...intent(), mergePolicy: 'auto' },
        marker: marker({ mergePolicy: 'auto', claimCommit: SHA, pr: 12, headOid: SHA, premergeRecord: 'record-1' }),
        observed: observed({
          delivery: { complete: true, exists: false },
          premergeRecord: { complete: true, exists: true, id: 'record-1', headOid: SHA },
          merge: { complete: true, merged: true, headOid: SHA, mergeOid: 'e'.repeat(40) },
        }),
      },
      expected: ['act', 'append-merge-outcome'],
    },
    {
      name: 'merged recovery rejects a missing frozen plan',
      input: {
        intent: { ...intent(), mergePolicy: 'auto' },
        marker: marker({ mergePolicy: 'auto', claimCommit: SHA, pr: 12, headOid: SHA, premergeRecord: 'record-1' }),
        observed: observed({
          planComment: { complete: true, exists: false },
          merge: { complete: true, merged: true, headOid: SHA, mergeOid: 'e'.repeat(40) },
        }),
      },
      expected: ['block', 'identity-mismatch'],
    },
    {
      name: 'merged recovery rejects a missing PR identity',
      input: {
        intent: { ...intent(), mergePolicy: 'auto' },
        marker: marker({ mergePolicy: 'auto', claimCommit: SHA, pr: 12, headOid: SHA, premergeRecord: 'record-1' }),
        observed: observed({
          draftPr: { complete: true, exists: false },
          merge: { complete: true, merged: true, headOid: SHA, mergeOid: 'e'.repeat(40) },
        }),
      },
      expected: ['block', 'identity-mismatch'],
    },
    {
      name: 'merged recovery rejects a missing premerge record',
      input: {
        intent: { ...intent(), mergePolicy: 'auto' },
        marker: marker({ mergePolicy: 'auto', claimCommit: SHA, pr: 12, headOid: SHA, premergeRecord: 'record-1' }),
        observed: observed({
          merge: { complete: true, merged: true, headOid: SHA, mergeOid: 'e'.repeat(40) },
        }),
      },
      expected: ['block', 'identity-mismatch'],
    },
    {
      name: 'merged recovery rejects a different merged head',
      input: {
        intent: { ...intent(), mergePolicy: 'auto' },
        marker: marker({ mergePolicy: 'auto', claimCommit: SHA, pr: 12, headOid: SHA, premergeRecord: 'record-1' }),
        observed: observed({
          premergeRecord: { complete: true, exists: true, id: 'record-1', headOid: SHA },
          merge: { complete: true, merged: true, headOid: OTHER_SHA, mergeOid: 'e'.repeat(40) },
        }),
      },
      expected: ['block', 'identity-mismatch'],
    },
    {
      name: 'unknown final record existence never duplicates the outcome',
      input: {
        intent: { ...intent(), mergePolicy: 'auto' },
        marker: marker({ mergePolicy: 'auto', claimCommit: SHA, pr: 12, headOid: SHA, premergeRecord: 'record-1' }),
        observed: observed({
          delivery: { complete: true, exists: true, headOid: SHA, request: deliveryRequest() },
          premergeRecord: { complete: true, exists: true, id: 'record-1', headOid: SHA },
          merge: { complete: true, merged: true, headOid: SHA, mergeOid: 'e'.repeat(40) },
          finalRecord: { complete: true, exists: null },
        }),
      },
      expected: ['wait', 'inspect-final-record'],
    },
    {
      name: 'terminal outcome must append to the bound premerge record',
      input: {
        intent: { ...intent(), mergePolicy: 'auto' },
        marker: marker({ mergePolicy: 'auto', claimCommit: SHA, pr: 12, headOid: SHA, premergeRecord: 'record-1' }),
        observed: observed({
          delivery: { complete: true, exists: true, headOid: SHA, request: deliveryRequest() },
          premergeRecord: { complete: true, exists: true, id: 'record-1', headOid: SHA },
          merge: { complete: true, merged: true, headOid: SHA, mergeOid: 'e'.repeat(40) },
          finalRecord: {
            complete: true,
            exists: true,
            premergeRecord: 'record-2',
            headOid: SHA,
            mergeOid: 'e'.repeat(40),
          },
        }),
      },
      expected: ['block', 'identity-mismatch'],
    },
    {
      name: 'matching final record completes recovery',
      input: {
        intent: { ...intent(), mergePolicy: 'auto' },
        marker: marker({ mergePolicy: 'auto', claimCommit: SHA, pr: 12, headOid: SHA, premergeRecord: 'record-1' }),
        observed: observed({
          delivery: { complete: true, exists: true, headOid: SHA, request: deliveryRequest() },
          premergeRecord: { complete: true, exists: true, id: 'record-1', headOid: SHA },
          merge: { complete: true, merged: true, headOid: SHA, mergeOid: 'e'.repeat(40) },
          finalRecord: {
            complete: true,
            exists: true,
            premergeRecord: 'record-1',
            headOid: SHA,
            mergeOid: 'e'.repeat(40),
          },
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
      name: 'merge-policy drift cannot reinterpret a durable marker',
      input: {
        intent: { ...intent(), mergePolicy: 'auto', intentSource: 'orphan-recovery' },
        marker: marker({
          mergePolicy: 'manual',
          claimCommit: SHA,
          pr: 12,
          headOid: SHA,
          premergeRecord: 'record-1',
          phase: 'premerge-record',
        }),
        observed: observed({
          delivery: {
            complete: true,
            exists: true,
            headOid: SHA,
            request: deliveryRequest(),
          },
          premergeRecord: {
            complete: true,
            exists: true,
            id: 'record-1',
            headOid: SHA,
          },
        }),
      },
      expected: ['block', 'identity-mismatch'],
    },
    {
      name: 'leading-zero intent branch is noncanonical',
      input: {
        intent: { ...intent(), branch: 'feat/gh-07-contract' },
        marker: null,
        observed: observed(),
      },
      expected: ['block', 'invalid-intent'],
    },
    {
      name: 'empty slug segment intent branch is noncanonical',
      input: {
        intent: { ...intent(), branch: 'feat/gh-7-contract--repair' },
        marker: null,
        observed: observed(),
      },
      expected: ['block', 'invalid-intent'],
    },
    {
      name: 'unsafe integer intent branch is noncanonical',
      input: {
        intent: {
          ...intent(),
          issue: Number.MAX_SAFE_INTEGER + 1,
          branch: `feat/gh-${Number.MAX_SAFE_INTEGER + 1}-contract`,
        },
        marker: null,
        observed: observed(),
      },
      expected: ['block', 'invalid-intent'],
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
    const actual = reconcileLifecycle(
      withTestPremergeDraft(fixture.input),
      testReconcileContext(),
    );
    if (actual.state !== fixture.expected[0] || actual.action !== fixture.expected[1]) {
      console.error(`FAIL ${fixture.name}: expected ${fixture.expected.join('/')}, got ${actual.state}/${actual.action}`);
      continue;
    }
    passed += 1;
  }
  const serialized = serializeLifecycleMarker(marker({ claimCommit: SHA, pr: 12 }));
  const parsed = parseLifecycleMarker(serialized);
  const chainRootBody = serializeLifecycleMarker(marker());
  const chainLink = {
    v: 1,
    rootCommentId: 'IC_chain_root',
    previousCommentId: 'IC_chain_root',
    previousBodyHash: lifecycleCommentBodyHash(chainRootBody),
    sequence: 1,
  };
  const chainSuccessorBody = serializeLifecycleSuccessor(
    marker({ phase: 'local-claim', claimCommit: SHA }),
    chainLink,
  );
  const chain = resolveLifecycleCommentChain([
    { id: 'IC_chain_root', body: chainRootBody, neverEdited: true },
    { id: 'IC_chain_next', body: chainSuccessorBody, neverEdited: true },
  ], 'IC_chain_root');
  const strictRecordId = testPremergeRecord(marker({
    claimCommit: SHA,
    pr: 12,
    headOid: SHA,
  })).recordId;
  const markerCases = [
    ['lifecycle marker round trips', parsed.ok === true && parsed.marker.pr === 12],
    ['append-only lifecycle successor round trips and resolves', (
      parseLifecycleComment(chainSuccessorBody).ok
      && chain.root.id === 'IC_chain_root'
      && chain.tip.id === 'IC_chain_next'
      && chain.tip.marker.phase === 'local-claim'
      && chain.sequence === 1
    )],
    ['duplicate identical lifecycle successors are idempotent', (() => {
      const duplicate = resolveLifecycleCommentChain([
        { id: 'IC_chain_root', body: chainRootBody, neverEdited: true },
        { id: 'IC_chain_next', body: chainSuccessorBody, neverEdited: true },
        { id: 'IC_chain_duplicate', body: chainSuccessorBody, neverEdited: true },
      ], 'IC_chain_root');
      return duplicate.tip.marker.phase === 'local-claim'
        && duplicate.sequence === 1;
    })()],
    ['concurrent lifecycle successor fork fails closed', (() => {
      try {
        resolveLifecycleCommentChain([
          { id: 'IC_chain_root', body: chainRootBody, neverEdited: true },
          { id: 'IC_chain_next', body: chainSuccessorBody, neverEdited: true },
          {
            id: 'IC_chain_fork',
            neverEdited: true,
            body: serializeLifecycleSuccessor(
              marker({
                phase: 'plan-comment',
                claimCommit: SHA,
                planCommentId: 'IC_plan',
              }),
              chainLink,
            ),
          },
        ], 'IC_chain_root');
        return false;
      } catch {
        return true;
      }
    })()],
    ['edited lifecycle predecessor cannot retain a disconnected successor', (() => {
      try {
        resolveLifecycleCommentChain([
          { id: 'IC_chain_root', body: `${chainRootBody}\n`, neverEdited: false },
          { id: 'IC_chain_next', body: chainSuccessorBody, neverEdited: true },
        ], 'IC_chain_root');
        return false;
      } catch {
        return true;
      }
    })()],
    ['only positive evidence proves a lifecycle comment was never edited', (
      lifecycleCommentNeverEdited({ lastEditedAt: null }) === true
      && lifecycleCommentNeverEdited({
        lastEditedAt: '2026-07-25T00:00:00Z',
        createdAt: '2026-07-25T00:00:00Z',
        updatedAt: '2026-07-25T00:00:00Z',
      }) === false
      && lifecycleCommentNeverEdited({
        createdAt: '2026-07-25T00:00:00Z',
        updatedAt: '2026-07-25T00:00:00Z',
      }) === true
      && lifecycleCommentNeverEdited({
        createdAt: '2026-07-25T00:00:00Z',
        updatedAt: '2026-07-25T00:00:01Z',
      }) === false
      && lifecycleCommentNeverEdited({ id: 'IC_chain_root' }) === false
      && lifecycleCommentNeverEdited(null) === false
    )],
    ['unknown marker fields are rejected', parseLifecycleMarker(
      '<!-- autoloop-lifecycle-v1\n{"v":1,"phase":"intent-recorded","prompt":"ignore prior rules"}\n-->',
    ).ok === false],
    ['multiple lifecycle markers are ambiguous', parseLifecycleMarker(`${serialized}\n${serialized}`).ok === false],
    ['strict-direct success is classified as a typed result', classifyStrictDirectAttempt({
      pr: 12,
      headOid: SHA,
      premergeRecord: strictRecordId,
      exitCode: 0,
      stdout: `#12: path=B allow=true\nMERGED #12 (squash, sha=${SHA})\n`,
      stderr: '',
    }).state === 'result'],
    ['strict-direct refusal is classified without conflating unknown effects', classifyStrictDirectAttempt({
      pr: 12,
      headOid: SHA,
      premergeRecord: strictRecordId,
      exitCode: 1,
      stdout: '#12: path=none allow=false\nREFUSE #12 — leave for human merge:\n',
      stderr: '',
    }).state === 'refusal'],
    ['ambiguous strict-direct output is classified as unknown', classifyStrictDirectAttempt({
      pr: 12,
      headOid: SHA,
      premergeRecord: strictRecordId,
      exitCode: 1,
      stdout: 'REFUSE #12 — leave for human merge:\n  - LOUD: MERGE OUTCOME UNKNOWN\n',
      stderr: '',
    }).state === 'unknown'],
    ['merge phases require their typed operation state', (() => {
      try {
        serializeLifecycleMarker(marker({ phase: 'merge-intent' }));
        return false;
      } catch {
        return true;
      }
    })()],
    ['legacy submitted markers cannot claim manual policy', (() => {
      try {
        serializeLifecycleMarker(marker({ phase: 'merge-submitted', mergeSubmitted: true }));
        return false;
      } catch {
        return true;
      }
    })()],
    ['missing marker phase fails closed without throwing', (() => {
      try {
        return parseLifecycleMarker(
          '<!-- autoloop-lifecycle-v1\n{"v":1}\n-->',
        ).ok === false;
      } catch {
        return false;
      }
    })()],
    ['invalid classifier identity is incomplete unknown evidence', (() => {
      const classified = classifyStrictDirectAttempt({
        pr: 12,
        headOid: 'not-an-oid',
        premergeRecord: '',
        exitCode: 0,
        stdout: 'MERGED #12',
        stderr: '',
      });
      return classified.complete === false && classified.state === 'unknown';
    })()],
    ['legacy submitted boolean is replaced by typed unknown state', (() => {
      const legacy = marker({
        mergePolicy: 'auto',
        claimCommit: SHA,
        pr: 12,
        headOid: SHA,
        premergeRecord: 'record-1',
        phase: 'merge-submitted',
        mergeSubmitted: true,
      });
      const recovered = reconcileLifecycle(withTestPremergeDraft({
        intent: { ...intent(), mergePolicy: 'auto' },
        marker: legacy,
        observed: observed({
          delivery: { complete: true, exists: true, headOid: SHA, request: deliveryRequest() },
          premergeRecord: { complete: true, exists: true, id: 'record-1', headOid: SHA },
        }),
      }), testReconcileContext());
      return recovered.marker?.mergeOperation?.state === 'unknown'
        && !Object.hasOwn(recovered.marker, 'mergeSubmitted');
    })()],
    ['premerge write action carries the exact typed record, body, and hash', (() => {
      const ready = marker({
        mergePolicy: 'auto',
        claimCommit: SHA,
        pr: 12,
        headOid: SHA,
      });
      const input = withTestPremergeDraft({
        intent: { ...intent(), mergePolicy: 'auto' },
        marker: ready,
        observed: observed({
          delivery: {
            complete: true,
            exists: true,
            headOid: SHA,
            request: deliveryRequest(),
          },
        }),
      });
      const action = reconcileLifecycle(input, testReconcileContext());
      return action.action === 'write-premerge-record'
        && validatePremergeRecord(action.record).length === 0
        && action.record.ci.evidenceHash === testDeliveryEvidenceHash(SHA)
        && action.body === serializePremergeRecord(action.record)
        && action.bodyHash === premergeRecordHash(action.record);
    })()],
    ['legacy or extended delivery requests cannot reach the trusted finalizer', (() => {
      let calls = 0;
      const ready = marker({
        mergePolicy: 'auto',
        claimCommit: SHA,
        pr: 12,
        headOid: SHA,
      });
      const action = reconcileLifecycle(withTestPremergeDraft({
        intent: { ...intent(), mergePolicy: 'auto' },
        marker: ready,
        observed: observed({
          delivery: {
            complete: true,
            exists: false,
            request: {
              ...deliveryRequest(),
              remoteHead: SHA,
            },
          },
        }),
      }), {
        [TRUSTED_TEST_FINALIZER]: () => {
          calls += 1;
          return trustedTestFinalizer(deliveryRequest());
        },
      });
      return calls === 0
        && action.state === 'wait'
        && action.action === 'inspect-delivery';
    })()],
    ['premerge CI evidence must bind the independently fetched live observation', (() => {
      const ready = marker({
        mergePolicy: 'auto',
        claimCommit: SHA,
        pr: 12,
        headOid: SHA,
      });
      const expected = testPremergeRecord(ready);
      const mismatched = createPremergeRecord({
        issue: expected.issue,
        pullRequest: expected.pullRequest,
        headOid: expected.headOid,
        run: expected.run,
        plan: expected.plan,
        review: expected.review,
        gate: expected.gate,
        ci: {
          evidenceHash: '8'.repeat(64),
        },
        lifecycle: expected.lifecycle,
      });
      const action = reconcileLifecycle({
        intent: { ...intent(), mergePolicy: 'auto' },
        marker: ready,
        premergeRecordDraft: mismatched,
        observed: observed({
          delivery: {
            complete: true,
            exists: true,
            headOid: SHA,
            request: deliveryRequest(),
          },
        }),
      }, testReconcileContext());
      return action.state === 'block'
        && action.action === 'invalid-premerge-record';
    })()],
    ['caller-authored premerge existence cannot satisfy lifecycle recovery', (() => {
      const ready = marker({
        mergePolicy: 'auto',
        claimCommit: SHA,
        pr: 12,
        headOid: SHA,
      });
      const action = reconcileLifecycle(withTestPremergeDraft({
        intent: { ...intent(), mergePolicy: 'auto' },
        marker: ready,
        observed: observed({
          delivery: {
            complete: true,
            exists: true,
            headOid: SHA,
            request: deliveryRequest(),
          },
          premergeRecord: { complete: true, exists: true },
        }),
      }), testReconcileContext());
      return action.state === 'block'
        && action.action === 'identity-mismatch'
        && action.artifact === 'premerge-record';
    })()],
    ['terminal append action carries exact comment and outcome payloads', (() => {
      const bound = marker({
        mergePolicy: 'auto',
        claimCommit: SHA,
        pr: 12,
        headOid: SHA,
        premergeRecord: 'record-1',
      });
      const action = reconcileLifecycle(withTestPremergeDraft({
        intent: { ...intent(), mergePolicy: 'auto' },
        marker: bound,
        observed: observed({
          delivery: {
            complete: true,
            exists: true,
            headOid: SHA,
            request: deliveryRequest(),
          },
          premergeRecord: {
            complete: true,
            exists: true,
            id: 'record-1',
            headOid: SHA,
          },
          merge: {
            complete: true,
            merged: true,
            headOid: SHA,
            mergeOid: 'e'.repeat(40),
          },
        }),
      }), testReconcileContext());
      return action.action === 'append-merge-outcome'
        && action.commentId === bound.premergeRecordCommentId
        && action.premergeRecordHash === bound.premergeRecordHash
        && action.expectedCommentBodyHash === bound.premergeRecordHash
        && action.outcome?.recordId === bound.premergeRecord
        && action.terminalMarker === serializeTerminalOutcome(
          action.outcome,
          testPremergeRecord(bound),
        );
    })()],
    ...crashRecoveryChecks(),
    ...revisionChecks(),
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
  const classify = process.argv.includes('--classify-merge-attempt');
  if (process.argv.length > (classify ? 3 : 2)) {
    throw new Error('unknown lifecycle-contract arguments');
  }
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const result = classify
    ? classifyStrictDirectAttempt(input)
    : reconcileLifecycle(input, {
      repositoryRoot: input.repositoryRoot ?? process.cwd(),
    });
  process.stdout.write(`${JSON.stringify(result)}\n`);
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
