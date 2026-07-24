#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SHA_RE = /^[0-9a-f]{40}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const LABELS = new Set(['risk:pure-deletion', 'risk:mechanical-refactor']);
const KINDS = new Set(['ownership', 'policy', 'human-authorization']);
const BASE_KEYS = ['kind', 'v', 'headOid'];
const KEYS = {
  ownership: [...BASE_KEYS, 'issue', 'issueBodyHash', 'claimCommitOid', 'frozenPlanHash'],
  policy: [
    ...BASE_KEYS,
    'issue',
    'blocked',
    'dependenciesClear',
    'delivered',
    'premergeRecord',
    'serverPolicy',
  ],
  'human-authorization': [...BASE_KEYS, 'actor', 'label'],
};
const SERVER_KEYS = [
  'complete',
  'strategy',
  'strict',
  'enforceAdmins',
  'actorCanBypass',
  'requiredConversationResolution',
  'requiredApprovingReviewCount',
  'dismissStaleReviews',
  'requireLastPushApproval',
  'forcePushesAllowed',
  'deletionsAllowed',
  'requiredChecks',
  'queueAvailable',
  'queueRequired',
  'mergeGroupCi',
  'asyncOutcomeRecovery',
];

function exactKeys(value, expected) {
  return (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0')
  );
}

function validChecks(value) {
  return (
    Array.isArray(value)
    && value.length > 0
    && value.every((check) =>
      exactKeys(check, ['name', 'appIds'])
      && typeof check.name === 'string'
      && check.name.length > 0
      && Array.isArray(check.appIds)
      && check.appIds.length > 0
      && check.appIds.every((id) => Number.isInteger(id) && id > 0))
  );
}

function validServerPolicy(value) {
  if (!exactKeys(value, SERVER_KEYS)) return false;
  if (
    value.complete !== true
    || !['direct-strict', 'merge-queue'].includes(value.strategy)
    || typeof value.strict !== 'boolean'
    || typeof value.enforceAdmins !== 'boolean'
    || typeof value.actorCanBypass !== 'boolean'
    || typeof value.requiredConversationResolution !== 'boolean'
    || !Number.isInteger(value.requiredApprovingReviewCount)
    || value.requiredApprovingReviewCount < 0
    || typeof value.dismissStaleReviews !== 'boolean'
    || typeof value.requireLastPushApproval !== 'boolean'
    || typeof value.forcePushesAllowed !== 'boolean'
    || typeof value.deletionsAllowed !== 'boolean'
    || typeof value.queueAvailable !== 'boolean'
    || typeof value.queueRequired !== 'boolean'
    || typeof value.mergeGroupCi !== 'boolean'
    || typeof value.asyncOutcomeRecovery !== 'boolean'
    || !validChecks(value.requiredChecks)
  ) {
    return false;
  }
  return value.strategy === 'direct-strict'
    ? value.strict === true
    : value.queueAvailable === true
      && value.queueRequired === true
      && value.mergeGroupCi === true
      && value.asyncOutcomeRecovery === true;
}

export function validateAttestation(value, expected = {}) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return ['attestation must be an object'];
  }
  if (!KINDS.has(value.kind)) return ['attestation kind is unsupported'];
  if (!exactKeys(value, KEYS[value.kind])) errors.push('attestation keys do not match its schema');
  if (value.v !== 1) errors.push('attestation version must be 1');
  if (!SHA_RE.test(value.headOid ?? '')) errors.push('headOid must be a lowercase commit OID');
  if (expected.kind !== undefined && value.kind !== expected.kind) errors.push('attestation kind mismatch');
  if (expected.headOid !== undefined && value.headOid !== expected.headOid) errors.push('attestation head mismatch');

  if (value.kind === 'ownership') {
    if (!Number.isInteger(value.issue) || value.issue < 1) errors.push('issue must be positive');
    if (!HASH_RE.test(value.issueBodyHash ?? '')) errors.push('issueBodyHash must be SHA-256');
    if (!SHA_RE.test(value.claimCommitOid ?? '')) errors.push('claimCommitOid must be a commit OID');
    if (!HASH_RE.test(value.frozenPlanHash ?? '')) errors.push('frozenPlanHash must be SHA-256');
  } else if (value.kind === 'policy') {
    if (!Number.isInteger(value.issue) || value.issue < 1) errors.push('issue must be positive');
    for (const key of ['blocked', 'dependenciesClear', 'delivered']) {
      if (typeof value[key] !== 'boolean') errors.push(`${key} must be boolean`);
    }
    if (typeof value.premergeRecord !== 'string' || value.premergeRecord.length === 0) {
      errors.push('premergeRecord must be non-empty');
    }
    if (!validServerPolicy(value.serverPolicy)) errors.push('serverPolicy is invalid or incomplete');
  } else {
    if (typeof value.actor !== 'string' || value.actor.length === 0) errors.push('actor must be non-empty');
    if (!LABELS.has(value.label)) errors.push('authorization label is unsupported');
  }
  return errors;
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

export function serializeAttestation(value) {
  const errors = validateAttestation(value);
  if (errors.length > 0) throw new Error(errors.join('; '));
  return `<!-- autoloop-attestation-v1\n${stableJson(value)}\n-->`;
}

export function parseAttestation(summary, expected = {}) {
  if (typeof summary !== 'string' || summary.length > 65535) {
    return { ok: false, error: 'attestation summary is missing or too large' };
  }
  const match = /^<!-- autoloop-attestation-v1\r?\n([\s\S]*?)\r?\n-->$/u.exec(summary);
  if (!match) return { ok: false, error: 'attestation marker is missing or not exact' };
  let value;
  try {
    value = JSON.parse(match[1]);
  } catch {
    return { ok: false, error: 'attestation JSON is invalid' };
  }
  const errors = validateAttestation(value, expected);
  return errors.length > 0 ? { ok: false, error: errors.join('; ') } : { ok: true, attestation: value };
}

function policyFixture() {
  return {
    kind: 'policy',
    v: 1,
    headOid: 'a'.repeat(40),
    issue: 7,
    blocked: false,
    dependenciesClear: true,
    delivered: true,
    premergeRecord: 'record-1',
    serverPolicy: {
      complete: true,
      strategy: 'direct-strict',
      strict: true,
      enforceAdmins: true,
      actorCanBypass: false,
      requiredConversationResolution: true,
      requiredApprovingReviewCount: 1,
      dismissStaleReviews: true,
      requireLastPushApproval: true,
      forcePushesAllowed: false,
      deletionsAllowed: false,
      requiredChecks: [{ name: 'agentic/gate', appIds: [42] }],
      queueAvailable: false,
      queueRequired: false,
      mergeGroupCi: false,
      asyncOutcomeRecovery: false,
    },
  };
}

function selfTest() {
  const ownership = {
    kind: 'ownership',
    v: 1,
    headOid: 'a'.repeat(40),
    issue: 7,
    issueBodyHash: 'b'.repeat(64),
    claimCommitOid: 'c'.repeat(40),
    frozenPlanHash: 'd'.repeat(64),
  };
  const authorization = {
    kind: 'human-authorization',
    v: 1,
    headOid: 'a'.repeat(40),
    actor: 'maintainer',
    label: 'risk:pure-deletion',
  };
  const policy = policyFixture();
  const cases = [
    ['ownership round trip', parseAttestation(serializeAttestation(ownership), {
      kind: 'ownership',
      headOid: ownership.headOid,
    }).ok],
    ['policy round trip', parseAttestation(serializeAttestation(policy), { kind: 'policy' }).ok],
    ['authorization round trip', parseAttestation(
      serializeAttestation(authorization),
      { kind: 'human-authorization' },
    ).ok],
    ['unknown key rejected', validateAttestation({ ...ownership, extra: true }).length > 0],
    ['head mismatch rejected', !parseAttestation(
      serializeAttestation(ownership),
      { headOid: 'e'.repeat(40) },
    ).ok],
    ['surrounding prose rejected', !parseAttestation(`note\n${serializeAttestation(ownership)}`).ok],
    ['unsafe authorization label rejected', validateAttestation({
      ...authorization,
      label: 'human:authorize',
    }).length > 0],
    ['queue policy without merge_group rejected', validateAttestation({
      ...policy,
      serverPolicy: {
        ...policy.serverPolicy,
        strategy: 'merge-queue',
        strict: false,
        queueAvailable: true,
        queueRequired: true,
        mergeGroupCi: false,
        asyncOutcomeRecovery: true,
      },
    }).length > 0],
  ];
  const failures = cases.filter(([, ok]) => !ok);
  for (const [name] of failures) console.error(`FAIL ${name}`);
  console.log(failures.length === 0
    ? `self-test OK (${cases.length} cases)`
    : `self-test FAILED (${failures.length}/${cases.length})`);
  return failures.length === 0;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) process.exit(selfTest() ? 0 : 1);
