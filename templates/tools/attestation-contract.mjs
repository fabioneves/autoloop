#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SHA_RE = /^[0-9a-f]{40}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const LABELS = new Set(['risk:pure-deletion', 'risk:mechanical-refactor']);
const KINDS = new Set(['gate', 'ownership', 'policy', 'human-authorization']);
const BASE_KEYS = ['kind', 'v', 'headOid'];
const KEYS = {
  gate: [
    ...BASE_KEYS,
    'commandHash',
    'configHash',
    'repositoryFingerprint',
  ],
  policy: [
    ...BASE_KEYS,
    'issue',
    'delivered',
    'premergeRecord',
  ],
  ownership: [
    ...BASE_KEYS,
    'issue',
    'issueBodyHash',
    'claimCommitOid',
    'frozenPlanHash',
    'frozenPlanCommentId',
    'frozenPlanAuthor',
  ],
  'human-authorization': [
    ...BASE_KEYS,
    'pullRequest',
    'actor',
    'label',
    'labelEventId',
    'labeledAt',
  ],
};

function exactKeys(value, expected) {
  return (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0')
  );
}

function validTimestamp(value) {
  return (
    typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value))
  );
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

  if (value.kind === 'gate') {
    if (!HASH_RE.test(value.commandHash ?? '')) errors.push('commandHash must be SHA-256');
    if (!HASH_RE.test(value.configHash ?? '')) errors.push('configHash must be SHA-256');
    if (!HASH_RE.test(value.repositoryFingerprint ?? '')) {
      errors.push('repositoryFingerprint must be SHA-256');
    }
  } else if (value.kind === 'ownership') {
    if (!Number.isInteger(value.issue) || value.issue < 1) errors.push('issue must be positive');
    if (!HASH_RE.test(value.issueBodyHash ?? '')) errors.push('issueBodyHash must be SHA-256');
    if (!SHA_RE.test(value.claimCommitOid ?? '')) errors.push('claimCommitOid must be a commit OID');
    if (!HASH_RE.test(value.frozenPlanHash ?? '')) errors.push('frozenPlanHash must be SHA-256');
    if (typeof value.frozenPlanCommentId !== 'string' || value.frozenPlanCommentId.length === 0) {
      errors.push('frozenPlanCommentId must be non-empty');
    }
    if (typeof value.frozenPlanAuthor !== 'string' || value.frozenPlanAuthor.length === 0) {
      errors.push('frozenPlanAuthor must be non-empty');
    }
  } else if (value.kind === 'policy') {
    if (!Number.isInteger(value.issue) || value.issue < 1) errors.push('issue must be positive');
    if (typeof value.delivered !== 'boolean') errors.push('delivered must be boolean');
    if (typeof value.premergeRecord !== 'string' || value.premergeRecord.length === 0) {
      errors.push('premergeRecord must be non-empty');
    }
  } else {
    if (!Number.isInteger(value.pullRequest) || value.pullRequest < 1) {
      errors.push('pullRequest must be positive');
    }
    if (typeof value.actor !== 'string' || value.actor.length === 0) errors.push('actor must be non-empty');
    if (!LABELS.has(value.label)) errors.push('authorization label is unsupported');
    if (!Number.isSafeInteger(value.labelEventId) || value.labelEventId < 1) {
      errors.push('labelEventId must be a positive safe integer');
    }
    if (!validTimestamp(value.labeledAt)) errors.push('labeledAt must be a GitHub UTC timestamp');
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
    delivered: true,
    premergeRecord: 'record-1',
  };
}

function selfTest() {
  const gate = {
    kind: 'gate',
    v: 1,
    headOid: 'a'.repeat(40),
    commandHash: 'b'.repeat(64),
    configHash: 'c'.repeat(64),
    repositoryFingerprint: 'd'.repeat(64),
  };
  const ownership = {
    kind: 'ownership',
    v: 1,
    headOid: 'a'.repeat(40),
    issue: 7,
    issueBodyHash: 'b'.repeat(64),
    claimCommitOid: 'c'.repeat(40),
    frozenPlanHash: 'd'.repeat(64),
    frozenPlanCommentId: 'IC_kwDOAutoloop7',
    frozenPlanAuthor: 'autoloop[bot]',
  };
  const authorization = {
    kind: 'human-authorization',
    v: 1,
    headOid: 'a'.repeat(40),
    pullRequest: 12,
    actor: 'maintainer',
    label: 'risk:pure-deletion',
    labelEventId: 123456,
    labeledAt: '2026-07-24T00:00:00Z',
  };
  const policy = policyFixture();
  const cases = [
    ['gate round trip', parseAttestation(serializeAttestation(gate), {
      kind: 'gate',
      headOid: gate.headOid,
    }).ok],
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
    ['caller-authored server policy rejected', validateAttestation({
      ...policy,
      serverPolicy: { complete: true },
    }).length > 0],
    ['ownership without frozen-plan comment identity rejected', validateAttestation({
      ...ownership,
      frozenPlanCommentId: '',
    }).length > 0],
    ['authorization without label event identity rejected', validateAttestation({
      ...authorization,
      labelEventId: null,
    }).length > 0],
    ['gate without command identity rejected', validateAttestation({
      ...gate,
      commandHash: null,
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
