#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SHA_RE = /^[0-9a-f]{40}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const RECORD_ID_RE = /^pmr_[0-9a-f]{64}$/;
const GITHUB_ID_RE = /^[A-Za-z0-9_:-]{1,128}$/;
const GITHUB_LOGIN_RE = /^[A-Za-z0-9-]{1,100}(?:\[bot\])?$/;
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
    'pullRequest',
    'delivered',
    'premergeRecordId',
    'premergeRecordHash',
    'premergeRecordAuthor',
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
const PREMERGE_KEYS = [
  'kind',
  'v',
  'recordId',
  'issue',
  'pullRequest',
  'headOid',
  'run',
  'plan',
  'review',
  'gate',
  'ci',
  'lifecycle',
];
const PREMERGE_SEED_KEYS = PREMERGE_KEYS.filter((key) =>
  !new Set(['kind', 'v', 'recordId']).has(key));
const PREMERGE_PART_KEYS = {
  run: ['intentHash', 'receiptFingerprint'],
  plan: ['commentId', 'contentHash'],
  review: ['checkRunId', 'summaryHash'],
  gate: ['checkRunId', 'summaryHash'],
  ci: ['policyHash', 'evidenceHash'],
  lifecycle: ['commentId', 'identityHash'],
};
const TERMINAL_KEYS = [
  'kind',
  'v',
  'recordId',
  'issue',
  'pullRequest',
  'headOid',
  'outcome',
  'mergeOid',
];

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
    if (!Number.isInteger(value.pullRequest) || value.pullRequest < 1) {
      errors.push('pullRequest must be positive');
    }
    if (typeof value.delivered !== 'boolean') errors.push('delivered must be boolean');
    if (!RECORD_ID_RE.test(value.premergeRecordId ?? '')) {
      errors.push('premergeRecordId must be a strict premerge record ID');
    }
    if (!HASH_RE.test(value.premergeRecordHash ?? '')) {
      errors.push('premergeRecordHash must be SHA-256');
    }
    if (!GITHUB_LOGIN_RE.test(value.premergeRecordAuthor ?? '')) {
      errors.push('premergeRecordAuthor must be a strict GitHub login');
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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function validGitHubId(value) {
  return typeof value === 'string' && GITHUB_ID_RE.test(value);
}

export function validPremergeRecordId(value) {
  return typeof value === 'string' && RECORD_ID_RE.test(value);
}

function premergeSeed(record) {
  return Object.fromEntries(PREMERGE_SEED_KEYS.map((key) => [key, record[key]]));
}

function validatePremergeSeed(seed) {
  const errors = [];
  if (!exactKeys(seed, PREMERGE_SEED_KEYS)) return ['premerge seed keys do not match its schema'];
  if (!Number.isSafeInteger(seed.issue) || seed.issue < 1) errors.push('issue must be positive');
  if (!Number.isSafeInteger(seed.pullRequest) || seed.pullRequest < 1) {
    errors.push('pullRequest must be positive');
  }
  if (!SHA_RE.test(seed.headOid ?? '')) errors.push('headOid must be a lowercase commit OID');
  for (const [part, keys] of Object.entries(PREMERGE_PART_KEYS)) {
    if (!exactKeys(seed[part], keys)) {
      errors.push(`${part} keys do not match its schema`);
      continue;
    }
    for (const [key, value] of Object.entries(seed[part])) {
      if (key.endsWith('Hash') || key.endsWith('Fingerprint')) {
        if (!HASH_RE.test(value ?? '')) errors.push(`${part}.${key} must be SHA-256`);
      } else if (key === 'checkRunId') {
        if (!Number.isSafeInteger(value) || value < 1) {
          errors.push(`${part}.${key} must be a positive safe integer`);
        }
      } else if (!validGitHubId(value)) {
        errors.push(`${part}.${key} must be a strict GitHub identifier`);
      }
    }
  }
  return errors;
}

export function createPremergeRecord(seed) {
  const errors = validatePremergeSeed(seed);
  if (errors.length > 0) throw new Error(`invalid premerge seed: ${errors.join('; ')}`);
  const identity = { kind: 'premerge-record', v: 1, ...seed };
  return {
    ...identity,
    recordId: `pmr_${sha256(stableJson(identity))}`,
  };
}

export function validatePremergeRecord(record) {
  const errors = [];
  if (!exactKeys(record, PREMERGE_KEYS)) return ['premerge record keys do not match its schema'];
  if (record.kind !== 'premerge-record') errors.push('premerge record kind is invalid');
  if (record.v !== 1) errors.push('premerge record version must be 1');
  const seedErrors = validatePremergeSeed(premergeSeed(record));
  errors.push(...seedErrors);
  if (!validPremergeRecordId(record.recordId)) {
    errors.push('recordId must be a strict premerge record ID');
  } else if (seedErrors.length === 0) {
    const expected = createPremergeRecord(premergeSeed(record)).recordId;
    if (record.recordId !== expected) errors.push('recordId is not derived from the complete record');
  }
  return errors;
}

export function serializePremergeRecord(record) {
  const errors = validatePremergeRecord(record);
  if (errors.length > 0) throw new Error(`invalid premerge record: ${errors.join('; ')}`);
  return `<!-- autoloop-premerge-record-v1\n${stableJson(record)}\n-->`;
}

export function premergeRecordHash(record) {
  return sha256(serializePremergeRecord(record));
}

export function createTerminalOutcome(record, mergeOid) {
  const errors = validatePremergeRecord(record);
  if (errors.length > 0) throw new Error(`invalid premerge record: ${errors.join('; ')}`);
  if (!SHA_RE.test(mergeOid ?? '')) throw new Error('mergeOid must be a lowercase commit OID');
  return {
    kind: 'premerge-terminal',
    v: 1,
    recordId: record.recordId,
    issue: record.issue,
    pullRequest: record.pullRequest,
    headOid: record.headOid,
    outcome: 'merged',
    mergeOid,
  };
}

export function validateTerminalOutcome(outcome, record = null) {
  const errors = [];
  if (!exactKeys(outcome, TERMINAL_KEYS)) return ['terminal outcome keys do not match its schema'];
  if (outcome.kind !== 'premerge-terminal') errors.push('terminal outcome kind is invalid');
  if (outcome.v !== 1) errors.push('terminal outcome version must be 1');
  if (!validPremergeRecordId(outcome.recordId)) errors.push('terminal recordId is invalid');
  if (!Number.isSafeInteger(outcome.issue) || outcome.issue < 1) {
    errors.push('terminal issue must be positive');
  }
  if (!Number.isSafeInteger(outcome.pullRequest) || outcome.pullRequest < 1) {
    errors.push('terminal pullRequest must be positive');
  }
  if (!SHA_RE.test(outcome.headOid ?? '')) errors.push('terminal headOid is invalid');
  if (outcome.outcome !== 'merged') errors.push('terminal outcome must be merged');
  if (!SHA_RE.test(outcome.mergeOid ?? '')) errors.push('terminal mergeOid is invalid');
  if (
    record
    && (
      outcome.recordId !== record.recordId
      || outcome.issue !== record.issue
      || outcome.pullRequest !== record.pullRequest
      || outcome.headOid !== record.headOid
    )
  ) {
    errors.push('terminal outcome is not bound to its premerge record');
  }
  return errors;
}

export function serializeTerminalOutcome(outcome, record = null) {
  const errors = validateTerminalOutcome(outcome, record);
  if (errors.length > 0) throw new Error(`invalid terminal outcome: ${errors.join('; ')}`);
  return `<!-- autoloop-premerge-terminal-v1\n${stableJson(outcome)}\n-->`;
}

export function parseTerminalOutcomeComment(body, record = null) {
  if (typeof body !== 'string' || body.length === 0 || body.length > 65535) {
    return { ok: false, error: 'terminal outcome comment is missing or too large' };
  }
  const match = /^(<!-- autoloop-premerge-terminal-v1\r?\n([\s\S]*?)\r?\n-->)$/u.exec(body);
  if (!match) {
    return { ok: false, error: 'terminal outcome comment marker is missing or not exact' };
  }
  let outcome;
  try {
    outcome = JSON.parse(match[2]);
  } catch {
    return { ok: false, error: 'terminal outcome comment JSON is invalid' };
  }
  const errors = validateTerminalOutcome(outcome, record);
  if (errors.length > 0) return { ok: false, error: errors.join('; ') };
  if (match[1] !== serializeTerminalOutcome(outcome, record)) {
    return { ok: false, error: 'terminal outcome comment is not canonical' };
  }
  return { ok: true, outcome };
}

export function parsePremergeRecordComment(body) {
  if (typeof body !== 'string' || body.length === 0 || body.length > 65535) {
    return { ok: false, error: 'premerge comment body is missing or too large' };
  }
  const match = /^(<!-- autoloop-premerge-record-v1\r?\n([\s\S]*?)\r?\n-->)(?:\r?\n(<!-- autoloop-premerge-terminal-v1\r?\n([\s\S]*?)\r?\n-->))?$/u.exec(body);
  if (!match) return { ok: false, error: 'premerge comment markers are missing or not exact' };
  let record;
  let outcome = null;
  try {
    record = JSON.parse(match[2]);
    if (match[4] !== undefined) outcome = JSON.parse(match[4]);
  } catch {
    return { ok: false, error: 'premerge comment JSON is invalid' };
  }
  const recordErrors = validatePremergeRecord(record);
  if (recordErrors.length > 0) return { ok: false, error: recordErrors.join('; ') };
  const canonicalRecord = serializePremergeRecord(record);
  if (match[1] !== canonicalRecord) {
    return { ok: false, error: 'premerge record marker is not canonical' };
  }
  if (outcome !== null) {
    const outcomeErrors = validateTerminalOutcome(outcome, record);
    if (outcomeErrors.length > 0) return { ok: false, error: outcomeErrors.join('; ') };
    if (match[3] !== serializeTerminalOutcome(outcome, record)) {
      return { ok: false, error: 'terminal outcome marker is not canonical' };
    }
  }
  return {
    ok: true,
    record,
    outcome,
    premergeBody: canonicalRecord,
    premergeBodyHash: sha256(canonicalRecord),
  };
}

export function reconcileTerminalOutcome(body, outcome) {
  const parsed = parsePremergeRecordComment(body);
  if (!parsed.ok) throw new Error(parsed.error);
  const errors = validateTerminalOutcome(outcome, parsed.record);
  if (errors.length > 0) throw new Error(errors.join('; '));
  const marker = serializeTerminalOutcome(outcome, parsed.record);
  if (parsed.outcome === null) {
    return { changed: true, body: `${parsed.premergeBody}\n${marker}` };
  }
  if (stableJson(parsed.outcome) !== stableJson(outcome)) {
    throw new Error('premerge record already has a conflicting terminal outcome');
  }
  return { changed: false, body };
}

function recordIdHint(body) {
  if (typeof body !== 'string' || !body.includes('autoloop-premerge-record-v1')) return null;
  return /"recordId"\s*:\s*"(pmr_[0-9a-f]{64})"/u.exec(body)?.[1] ?? null;
}

function terminalRecordIdHint(body) {
  if (typeof body !== 'string' || !body.includes('autoloop-premerge-terminal-v1')) return null;
  return /"recordId"\s*:\s*"(pmr_[0-9a-f]{64})"/u.exec(body)?.[1] ?? null;
}

export function derivePremergeRecordObservation(comments, expected = {}) {
  const empty = {
    complete: false,
    exists: false,
    verified: false,
    code: 'PREMERGE_COMMENTS_INCOMPLETE',
    id: null,
    bodyHash: null,
    commentBodyHash: null,
    commentId: null,
    outcomeCommentId: null,
    author: null,
    issue: null,
    pullRequest: null,
    headOid: null,
    record: null,
    outcome: null,
  };
  if (
    comments?.complete !== true
    || !Array.isArray(comments.items)
    || comments.items.some((comment) =>
      !validGitHubId(comment?.id)
      || (
        comment?.author?.login !== null
        && typeof comment?.author?.login !== 'string'
      )
      || typeof comment?.body !== 'string')
    || new Set(comments.items.map((comment) => comment.id)).size
      !== comments.items.length
  ) {
    return empty;
  }
  if (
    !Number.isSafeInteger(expected.issue)
    || expected.issue < 1
    || !SHA_RE.test(expected.headOid ?? '')
    || !validPremergeRecordId(expected.recordId)
    || !HASH_RE.test(expected.bodyHash ?? '')
    || typeof expected.author !== 'string'
    || expected.author.length === 0
  ) {
    return { ...empty, complete: true, code: 'PREMERGE_EXPECTATION_INVALID' };
  }
  const markerCandidates = comments.items.filter((comment) =>
    comment.body.includes('autoloop-premerge-record-v1'));
  const malformedTrusted = markerCandidates.some((comment) =>
    comment.author.login === expected.author
    && !parsePremergeRecordComment(comment.body).ok);
  const candidates = markerCandidates.filter((comment) =>
    recordIdHint(comment.body) === expected.recordId);
  if (candidates.length === 0) {
    if (malformedTrusted) {
      return {
        ...empty,
        complete: true,
        exists: true,
        code: 'PREMERGE_RECORD_MALFORMED',
      };
    }
    return { ...empty, complete: true, code: 'PREMERGE_RECORD_MISSING' };
  }
  const orderedCandidates = [...candidates].sort((left, right) =>
    left.id.localeCompare(right.id));
  const parsedCandidates = orderedCandidates.map((candidate) => ({
    candidate,
    parsed: parsePremergeRecordComment(candidate.body),
  }));
  if (parsedCandidates.some(({ parsed }) => !parsed.ok)) {
    return {
      ...empty,
      complete: true,
      exists: true,
      code: 'PREMERGE_RECORD_MALFORMED',
      id: expected.recordId,
    };
  }
  if (
    new Set(orderedCandidates.map((candidate) => candidate.body)).size !== 1
    || new Set(orderedCandidates.map((candidate) => candidate.author.login)).size !== 1
  ) {
    return {
      ...empty,
      complete: true,
      exists: true,
      code: 'PREMERGE_RECORD_CONFLICT',
      id: expected.recordId,
    };
  }
  const comment = orderedCandidates[0];
  const parsed = parsedCandidates[0].parsed;
  const terminalMarkerCandidates = comments.items.filter((candidate) =>
    candidate.body.includes('autoloop-premerge-terminal-v1')
    && !candidate.body.includes('autoloop-premerge-record-v1'));
  const malformedTrustedTerminal = terminalMarkerCandidates.some((candidate) =>
    candidate.author.login === expected.author
    && terminalRecordIdHint(candidate.body) === expected.recordId
    && !parseTerminalOutcomeComment(candidate.body, parsed.record).ok);
  const terminalCandidates = terminalMarkerCandidates.filter((candidate) =>
    terminalRecordIdHint(candidate.body) === expected.recordId);
  const parsedTerminals = terminalCandidates.map((candidate) => ({
    candidate,
    parsed: parseTerminalOutcomeComment(candidate.body, parsed.record),
  }));
  if (
    malformedTrustedTerminal
    || parsedTerminals.some(({ candidate, parsed: terminal }) =>
      !terminal.ok || candidate.author.login !== expected.author)
  ) {
    return {
      ...empty,
      complete: true,
      exists: true,
      code: 'PREMERGE_TERMINAL_MALFORMED',
      id: expected.recordId,
      commentId: comment.id,
      author: comment.author.login,
    };
  }
  const terminalBodies = new Set(
    parsedTerminals.map(({ candidate }) => candidate.body),
  );
  if (
    terminalBodies.size > 1
    || (parsed.outcome !== null && terminalBodies.size > 0)
  ) {
    return {
      ...empty,
      complete: true,
      exists: true,
      code: 'PREMERGE_TERMINAL_CONFLICT',
      id: expected.recordId,
      commentId: comment.id,
      author: comment.author.login,
    };
  }
  const terminalEntry = parsedTerminals[0] ?? null;
  const outcome = parsed.outcome ?? terminalEntry?.parsed.outcome ?? null;
  const matches = (
    parsed.record.recordId === expected.recordId
    && parsed.record.issue === expected.issue
    && parsed.record.headOid === expected.headOid
    && parsed.premergeBodyHash === expected.bodyHash
    && comment.author.login === expected.author
    && (expected.requireOutcomeAbsent !== true || outcome === null)
  );
  return {
    complete: true,
    exists: true,
    verified: matches,
    code: matches ? 'PREMERGE_RECORD_VERIFIED' : 'PREMERGE_RECORD_MISMATCH',
    id: parsed.record.recordId,
    bodyHash: parsed.premergeBodyHash,
    commentBodyHash: sha256(comment.body),
    commentId: comment.id,
    outcomeCommentId: terminalEntry?.candidate.id ?? (
      parsed.outcome === null ? null : comment.id
    ),
    author: comment.author.login,
    issue: parsed.record.issue,
    pullRequest: parsed.record.pullRequest,
    headOid: parsed.record.headOid,
    record: parsed.record,
    outcome,
  };
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
    pullRequest: 12,
    delivered: true,
    premergeRecordId: `pmr_${'e'.repeat(64)}`,
    premergeRecordHash: 'f'.repeat(64),
    premergeRecordAuthor: 'autoloop[bot]',
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
  const premerge = createPremergeRecord({
    issue: 7,
    pullRequest: 12,
    headOid: 'a'.repeat(40),
    run: {
      intentHash: '1'.repeat(64),
      receiptFingerprint: '2'.repeat(64),
    },
    plan: {
      commentId: 'IC_plan',
      contentHash: '3'.repeat(64),
    },
    review: {
      checkRunId: 101,
      summaryHash: '4'.repeat(64),
    },
    gate: {
      checkRunId: 102,
      summaryHash: '5'.repeat(64),
    },
    ci: {
      policyHash: '6'.repeat(64),
      evidenceHash: '7'.repeat(64),
    },
    lifecycle: {
      commentId: 'IC_lifecycle',
      identityHash: '8'.repeat(64),
    },
  });
  const premergeBody = serializePremergeRecord(premerge);
  const premergeComment = {
    id: 'IC_premerge',
    author: { login: 'autoloop[bot]' },
    body: premergeBody,
  };
  const expectedPremerge = {
    issue: 7,
    headOid: premerge.headOid,
    recordId: premerge.recordId,
    bodyHash: premergeRecordHash(premerge),
    author: 'autoloop[bot]',
    requireOutcomeAbsent: true,
  };
  const observe = (items, overrides = {}) => derivePremergeRecordObservation(
    { complete: true, items },
    { ...expectedPremerge, ...overrides },
  );
  const terminal = createTerminalOutcome(premerge, '9'.repeat(40));
  const terminalComment = {
    id: 'IC_terminal',
    author: { login: 'autoloop[bot]' },
    body: serializeTerminalOutcome(terminal, premerge),
  };
  const conflictingTerminalComment = {
    id: 'IC_terminal_conflict',
    author: { login: 'autoloop[bot]' },
    body: serializeTerminalOutcome(
      createTerminalOutcome(premerge, 'a'.repeat(40)),
      premerge,
    ),
  };
  const appended = reconcileTerminalOutcome(premergeBody, terminal);
  const repeatedAppend = reconcileTerminalOutcome(appended.body, terminal);
  let conflictingTerminalRejected = false;
  try {
    reconcileTerminalOutcome(
      appended.body,
      createTerminalOutcome(premerge, 'a'.repeat(40)),
    );
  } catch {
    conflictingTerminalRejected = true;
  }
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
    ['legacy caller record string rejected', validateAttestation({
      kind: 'policy',
      v: 1,
      headOid: policy.headOid,
      issue: policy.issue,
      pullRequest: policy.pullRequest,
      delivered: true,
      premergeRecord: 'does-not-exist',
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
    ['premerge record round trip is canonical', (() => {
      const parsed = parsePremergeRecordComment(premergeBody);
      return parsed.ok
        && parsed.record.recordId === premerge.recordId
        && parsed.premergeBodyHash === premergeRecordHash(premerge);
    })()],
    ['complete comments prove exactly one dedicated-author record', (() => {
      const proof = observe([premergeComment]);
      return proof.verified
        && proof.commentId === premergeComment.id
        && proof.pullRequest === premerge.pullRequest;
    })()],
    ['missing premerge record fails closed', !observe([]).verified],
    ['identical duplicate premerge writes collapse deterministically', (() => {
      const proof = observe([
        premergeComment,
        { ...premergeComment, id: 'IC_premerge_duplicate' },
      ]);
      return proof.verified && proof.commentId === premergeComment.id;
    })()],
    ['divergent duplicate premerge writes fail closed', !observe([
      premergeComment,
      {
        ...premergeComment,
        id: 'IC_premerge_conflict',
        body: reconcileTerminalOutcome(premergeBody, terminal).body,
      },
    ], { requireOutcomeAbsent: false }).verified],
    ['edited premerge body fails closed', !observe([{
      ...premergeComment,
      body: `${premergeBody}\n`,
    }]).verified],
    ['wrong premerge author fails closed', !observe([{
      ...premergeComment,
      author: { login: 'maintainer' },
    }]).verified],
    ['wrong issue binding fails closed', !observe([premergeComment], { issue: 8 }).verified],
    ['wrong head binding fails closed', !observe([premergeComment], {
      headOid: 'b'.repeat(40),
    }).verified],
    ['incomplete comment pagination fails closed', !derivePremergeRecordObservation(
      { complete: false, items: [premergeComment] },
      expectedPremerge,
    ).verified],
    ['terminal append is exact and idempotent', (() => {
      const parsed = parsePremergeRecordComment(appended.body);
      return appended.changed
        && !repeatedAppend.changed
        && repeatedAppend.body === appended.body
        && parsed.ok
        && parsed.outcome?.mergeOid === terminal.mergeOid;
    })()],
    ['immutable terminal successor proves the exact premerge outcome', (() => {
      const proof = observe(
        [premergeComment, terminalComment],
        { requireOutcomeAbsent: false },
      );
      return proof.verified
        && proof.commentId === premergeComment.id
        && proof.outcomeCommentId === terminalComment.id
        && proof.outcome?.mergeOid === terminal.mergeOid;
    })()],
    ['duplicate identical immutable terminal successors are idempotent', (() => {
      const proof = observe(
        [
          premergeComment,
          terminalComment,
          { ...terminalComment, id: 'IC_terminal_duplicate' },
        ],
        { requireOutcomeAbsent: false },
      );
      return proof.verified && proof.outcome?.mergeOid === terminal.mergeOid;
    })()],
    ['conflicting immutable terminal successors fail closed', !observe(
      [premergeComment, terminalComment, conflictingTerminalComment],
      { requireOutcomeAbsent: false },
    ).verified],
    ['conflicting terminal append is rejected', conflictingTerminalRejected],
    ['premerge authorization rejects an already-terminal record', !derivePremergeRecordObservation(
      {
        complete: true,
        items: [{ ...premergeComment, body: appended.body }],
      },
      expectedPremerge,
    ).verified],
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
