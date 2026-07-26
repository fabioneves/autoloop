#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseLoopClaim } from './claim-contract.mjs';
import { parseLifecycleComment } from './lifecycle-contract.mjs';

// process.exit() discards async stdout still buffered in Node, and stdout is
// async whenever it is a pipe — a 313KB snapshot arrived at the measured-scan
// consumer truncated to one pipe buffer, blocking every Dev run at selection.
// A synchronous write (retrying EAGAIN on a full non-blocking pipe) hands every
// byte to the kernel before any exit path can run.
export function writeStdoutSync(payload) {
  const bytes = Buffer.from(payload, 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    try {
      offset += writeSync(1, bytes, offset, bytes.length - offset);
    } catch (error) {
      if (error.code === 'EAGAIN') continue;
      throw error;
    }
  }
}

export const SNAPSHOT_VERSION = 2;
export const QUEUE_EVIDENCE_VERSION = 1;
export const SNAPSHOT_SECTIONS = Object.freeze([
  'repo',
  'tree',
  'openPrs',
  'lifecycleMarkers',
  'queue',
  'blockedIssues',
  'openIssues',
  'mergedPrs',
  'unresolvedReviewThreads',
  'authorVerification',
]);
export const SNAPSHOT_INVALIDATION_REASONS = Object.freeze([
  'GIT_MUTATION',
  'ISSUE_MUTATION',
  'PR_MUTATION',
  'REVIEW_MUTATION',
  'WAIT_BOUNDARY',
  'UNKNOWN_MUTATION',
]);
export const SNAPSHOT_ABSENCE_REQUIREMENTS = Object.freeze({
  selection: Object.freeze([
    'authorVerification',
    'blockedIssues',
    'mergedPrs',
    'openIssues',
    'openPrs',
    'lifecycleMarkers',
    'queue',
  ]),
  actionability: Object.freeze([
    'authorVerification',
    'blockedIssues',
    'lifecycleMarkers',
    'openIssues',
    'openPrs',
    'unresolvedReviewThreads',
  ]),
  queueExhaustion: Object.freeze([
    'authorVerification',
    'blockedIssues',
    'mergedPrs',
    'openIssues',
    'openPrs',
    'lifecycleMarkers',
    'queue',
  ]),
  relaunch: Object.freeze([
    'authorVerification',
    'blockedIssues',
    'mergedPrs',
    'openIssues',
    'openPrs',
    'lifecycleMarkers',
    'queue',
  ]),
  stop: Object.freeze([
    'authorVerification',
    'blockedIssues',
    'mergedPrs',
    'openIssues',
    'openPrs',
    'lifecycleMarkers',
    'queue',
  ]),
});

const SNAPSHOT_KEYS = [
  'fingerprint',
  'generation',
  'invalidation',
  'kind',
  'scannedAt',
  'sections',
  'version',
];
const SECTION_KEYS = ['complete', 'error', 'items'];
const INVALIDATION_KEYS = ['reasonCodes', 'sections'];
const QUEUE_EVIDENCE_KEYS = [
  'configuredBaseBranch',
  'configFingerprint',
  'eligibleIssueNumbers',
  'fingerprint',
  'kind',
  'purpose',
  'repositoryFingerprint',
  'repositoryNameWithOwner',
  'requiredSections',
  'runInstanceFingerprint',
  'snapshotFingerprint',
  'snapshotGeneration',
  'version',
];
const ISSUE_ITEM_KEYS = [
  'number',
  'title',
  'body',
  'bodySha256',
  'updatedAt',
  'lastEditedAt',
  'labels',
];
const CHECK_CONTEXT_KEYS = [
  'kind',
  'name',
  'status',
  'conclusion',
  'detailsUrl',
];
const PULL_REQUEST_ITEM_KEYS = [
  'number',
  'title',
  'body',
  'isDraft',
  'reviewDecision',
  'headRefName',
  'headRefOid',
  'baseRefName',
  'mergeStateStatus',
  'mergeable',
  'mergedAt',
  'updatedAt',
  'author',
  'headRepository',
  'statusCheckState',
  'statusCheckRollup',
  'issue',
  'orphanCandidate',
  'ownership',
];
const QUEUE_ITEM_KEYS = [
  ...ISSUE_ITEM_KEYS,
  'blockedBy',
  'dependencies',
  'provenance',
];
const DEPENDENCY_ITEM_KEYS = ['number', 'state'];
const COMMENT_EVIDENCE_KEYS = [
  'kind',
  'id',
  'prNumber',
  'author',
  'authorAssociation',
  'body',
  'state',
  'createdAt',
  'updatedAt',
  'url',
];
const LABEL_EVIDENCE_KEYS = [
  'kind',
  'issueNumber',
  'author',
  'authorAssociation',
  'body',
  'createdAt',
  'updatedAt',
  'url',
];
const LIFECYCLE_MARKER_ITEM_KEYS = [
  'issueNumber',
  'id',
  'tipId',
  'sequence',
  'author',
  'authorAssociation',
  'body',
  'createdAt',
  'updatedAt',
  'url',
];
const REVIEW_THREAD_ITEM_KEYS = [
  'id',
  'prNumber',
  'path',
  'line',
  'originalLine',
  'isOutdated',
  'comments',
];
const AUTHOR_VERIFICATION_ITEM_KEYS = [
  'login',
  'roleName',
  'permission',
  'evidence',
];
const ROLE_PERMISSIONS = new Set(['admin', 'none', 'read', 'write']);
const REVIEW_STATES = new Set([
  'APPROVED',
  'CHANGES_REQUESTED',
  'COMMENTED',
  'DISMISSED',
  'PENDING',
]);
const REVIEW_DECISIONS = new Set(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']);
const MERGEABLE_STATES = new Set(['CONFLICTING', 'MERGEABLE', 'UNKNOWN']);
const MERGE_STATE_STATUSES = new Set([
  'BEHIND',
  'BLOCKED',
  'CLEAN',
  'DIRTY',
  'DRAFT',
  'HAS_HOOKS',
  'UNKNOWN',
  'UNSTABLE',
]);
const STATUS_STATES = new Set(['ERROR', 'EXPECTED', 'FAILURE', 'PENDING', 'SUCCESS']);
const ISSUE_STATES = new Set(['CLOSED', 'OPEN']);
const CHECK_STATUS_STATES = new Set([
  'COMPLETED',
  'IN_PROGRESS',
  'PENDING',
  'QUEUED',
  'REQUESTED',
  'WAITING',
]);
const CHECK_CONCLUSION_STATES = new Set([
  'ACTION_REQUIRED',
  'CANCELLED',
  'FAILURE',
  'NEUTRAL',
  'SKIPPED',
  'STALE',
  'STARTUP_FAILURE',
  'SUCCESS',
  'TIMED_OUT',
]);
const INVALIDATED_SECTIONS = {
  GIT_MUTATION: ['tree'],
  ISSUE_MUTATION: [
    'authorVerification',
    'blockedIssues',
    'lifecycleMarkers',
    'openIssues',
    'queue',
  ],
  PR_MUTATION: [
    'authorVerification',
    'blockedIssues',
    'lifecycleMarkers',
    'mergedPrs',
    'openIssues',
    'openPrs',
    'queue',
    'unresolvedReviewThreads',
  ],
  REVIEW_MUTATION: ['authorVerification', 'openPrs', 'unresolvedReviewThreads'],
  WAIT_BOUNDARY: [...SNAPSHOT_SECTIONS],
  UNKNOWN_MUTATION: [...SNAPSHOT_SECTIONS],
};

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hasExactKeys(value, keys) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || typeof value.toJSON === 'function'
  ) {
    return false;
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.some((key) => typeof key !== 'string')
    || ownKeys.sort().join('\0') !== [...keys].sort().join('\0')
  ) {
    return false;
  }
  return ownKeys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true
      && Object.hasOwn(descriptor, 'value')
      && !Object.hasOwn(descriptor, 'get')
      && !Object.hasOwn(descriptor, 'set');
  });
}

function isDenseJsonArray(value) {
  if (
    !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || typeof value.toJSON === 'function'
  ) {
    return false;
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (ownKeys[index] !== String(index)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, ownKeys[index]);
    if (
      descriptor?.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
      || Object.hasOwn(descriptor, 'get')
      || Object.hasOwn(descriptor, 'set')
    ) {
      return false;
    }
  }
  if (ownKeys[value.length] !== 'length') return false;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  return lengthDescriptor?.value === value.length
    && lengthDescriptor.enumerable === false
    && lengthDescriptor.configurable === false
    && typeof lengthDescriptor.writable === 'boolean';
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function errorRecord(code, message) {
  const normalizedCode = String(code ?? '');
  const normalized = String(message ?? 'snapshot section is incomplete')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  return {
    code: /^[A-Z][A-Z0-9_]{0,63}$/.test(normalizedCode)
      ? normalizedCode
      : 'SNAPSHOT_ERROR',
    message: normalized || 'snapshot section is incomplete',
  };
}

function validError(error) {
  return hasExactKeys(error, ['code', 'message'])
    && typeof error.code === 'string'
    && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
    && typeof error.message === 'string'
    && error.message.length > 0
    && error.message.length <= 300;
}

function validSection(section) {
  return hasExactKeys(section, SECTION_KEYS)
    && isDenseJsonArray(section.items)
    && typeof section.complete === 'boolean'
    && (
      (section.complete === true && section.error === null)
      || (section.complete === false && validError(section.error))
    );
}

function validTimestamp(value) {
  if (typeof value !== 'string') return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function nullableString(value) {
  return value === null || typeof value === 'string';
}

function validDateTime(value) {
  if (typeof value !== 'string') return false;
  const match =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const normalized = `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`;
  return new Date(timestamp).toISOString() === normalized;
}

function nullableDateTime(value) {
  return value === null || validDateTime(value);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validObjectId(value) {
  return typeof value === 'string'
    && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

function validIssueItem(item) {
  return hasExactKeys(item, ISSUE_ITEM_KEYS)
    && positiveInteger(item.number)
    && typeof item.title === 'string'
    && typeof item.body === 'string'
    && typeof item.bodySha256 === 'string'
    && /^[0-9a-f]{64}$/.test(item.bodySha256)
    && item.bodySha256 === sha256Text(item.body)
    && validDateTime(item.updatedAt)
    && nullableDateTime(item.lastEditedAt)
    && isDenseJsonArray(item.labels)
    && item.labels.every(nonEmptyString)
    && new Set(item.labels).size === item.labels.length;
}

function validCheckContext(item) {
  if (
    !hasExactKeys(item, CHECK_CONTEXT_KEYS)
    || !['check-run', 'status-context'].includes(item.kind)
    || !nonEmptyString(item.name)
    || !nullableString(item.detailsUrl)
  ) {
    return false;
  }
  if (item.kind === 'check-run') {
    return CHECK_STATUS_STATES.has(item.status)
      && (item.conclusion === null || CHECK_CONCLUSION_STATES.has(item.conclusion));
  }
  return STATUS_STATES.has(item.status) && item.conclusion === null;
}

function validPullRequestItem(item, _complete, repositoryNameWithOwner) {
  const loopOwned = item?.ownership === 'loop';
  const claim = parseLoopClaim({
    branch: item?.headRefName,
    body: item?.body,
  });
  const sameRepository = nonEmptyString(repositoryNameWithOwner)
    && item?.headRepository === repositoryNameWithOwner;
  return hasExactKeys(item, PULL_REQUEST_ITEM_KEYS)
    && positiveInteger(item.number)
    && typeof item.title === 'string'
    && typeof item.body === 'string'
    && typeof item.isDraft === 'boolean'
    && (item.reviewDecision === null || REVIEW_DECISIONS.has(item.reviewDecision))
    && nonEmptyString(item.headRefName)
    && validObjectId(item.headRefOid)
    && nonEmptyString(item.baseRefName)
    && MERGE_STATE_STATUSES.has(item.mergeStateStatus)
    && MERGEABLE_STATES.has(item.mergeable)
    && nullableDateTime(item.mergedAt)
    && validDateTime(item.updatedAt)
    && nullableString(item.author)
    && nullableString(item.headRepository)
    && (item.statusCheckState === null || STATUS_STATES.has(item.statusCheckState))
    && isDenseJsonArray(item.statusCheckRollup)
    && item.statusCheckRollup.every(validCheckContext)
    && (item.issue === null || positiveInteger(item.issue))
    && typeof item.orphanCandidate === 'boolean'
    && ['human', 'loop'].includes(item.ownership)
    && loopOwned === positiveInteger(item.issue)
    && loopOwned === (claim.valid && sameRepository)
    && (!loopOwned || claim.issue === item.issue)
    && item.orphanCandidate === (loopOwned && item.isDraft);
}

function validProvenance(value) {
  return hasExactKeys(value, ['labeledBy', 'labeledAt'])
    && nonEmptyString(value.labeledBy)
    && validDateTime(value.labeledAt);
}

function validQueueItem(item, complete) {
  const expectedDependencies = blockedByIssueNumbers(item?.body);
  const dependencyNumbers = Array.isArray(item?.dependencies)
    ? item.dependencies.map((dependency) => dependency?.number)
    : [];
  return hasExactKeys(item, QUEUE_ITEM_KEYS)
    && ISSUE_ITEM_KEYS.every((key) => key in item)
    && validIssueItem(Object.fromEntries(
      ISSUE_ITEM_KEYS.map((key) => [key, item[key]]),
    ))
    && isDenseJsonArray(item.blockedBy)
    && item.blockedBy.every(positiveInteger)
    && stableJson(item.blockedBy) === stableJson(expectedDependencies)
    && isDenseJsonArray(item.dependencies)
    && item.dependencies.every((dependency) =>
      hasExactKeys(dependency, DEPENDENCY_ITEM_KEYS)
      && positiveInteger(dependency.number)
      && ISSUE_STATES.has(dependency.state)
      && expectedDependencies.includes(dependency.number))
    && new Set(dependencyNumbers).size === dependencyNumbers.length
    && (
      !complete
      || stableJson(dependencyNumbers) === stableJson(expectedDependencies)
    )
    && (
      validProvenance(item.provenance)
      || (!complete && item.provenance === null)
    );
}

export function blockedByIssueNumbers(body) {
  const section = /##\s*Blocked by([\s\S]*?)(\n##\s|$)/i.exec(body ?? '');
  if (!section) return [];
  return [...new Set(
    [...section[1].matchAll(/#([1-9]\d*)/g)]
      .map((match) => Number(match[1])),
  )];
}

function validEvidenceItem(item, requireAuthor = false) {
  const expectedKeys = item?.kind === 'queue-label'
    ? LABEL_EVIDENCE_KEYS
    : COMMENT_EVIDENCE_KEYS;
  if (
    !hasExactKeys(item, expectedKeys)
    || !['issue-comment', 'queue-label', 'review', 'review-thread-comment'].includes(item.kind)
    || !(nonEmptyString(item.author) || (!requireAuthor && item.author === null))
    || !nullableString(item.authorAssociation)
    || typeof item.body !== 'string'
    || !nullableDateTime(item.createdAt)
    || !nullableDateTime(item.updatedAt)
    || !nullableString(item.url)
  ) {
    return false;
  }
  if (item.kind === 'queue-label') {
    return positiveInteger(item.issueNumber);
  }
  return positiveInteger(item.prNumber)
    && nonEmptyString(item.id)
    && (
      item.kind === 'review'
        ? REVIEW_STATES.has(item.state)
        : item.state === null
    );
}

function validReviewThreadItem(item) {
  return hasExactKeys(item, REVIEW_THREAD_ITEM_KEYS)
    && nonEmptyString(item.id)
    && positiveInteger(item.prNumber)
    && nonEmptyString(item.path)
    && (item.line === null || positiveInteger(item.line))
    && (item.originalLine === null || positiveInteger(item.originalLine))
    && typeof item.isOutdated === 'boolean'
    && isDenseJsonArray(item.comments)
    && item.comments.every((comment) =>
      comment?.kind === 'review-thread-comment'
      && validEvidenceItem(comment));
}

function validAuthorVerificationItem(item, complete) {
  return hasExactKeys(item, AUTHOR_VERIFICATION_ITEM_KEYS)
    && nonEmptyString(item.login)
    && nullableString(item.roleName)
    && (
      ROLE_PERMISSIONS.has(item.permission)
      || (!complete && item.permission === null)
    )
    && isDenseJsonArray(item.evidence)
    && item.evidence.length > 0
    && item.evidence.every((evidence) =>
      validEvidenceItem(evidence, true) && evidence.author === item.login);
}

function validLifecycleMarkerItem(item) {
  if (
    !hasExactKeys(item, LIFECYCLE_MARKER_ITEM_KEYS)
    || !positiveInteger(item.issueNumber)
    || !nonEmptyString(item.id)
    || !nonEmptyString(item.author)
    || !nullableString(item.authorAssociation)
    || typeof item.body !== 'string'
    || !validDateTime(item.createdAt)
    || !validDateTime(item.updatedAt)
    || !nullableString(item.url)
  ) {
    return false;
  }
  const parsed = parseLifecycleComment(item.body);
  return parsed.ok === true
    && parsed.marker.issue === item.issueNumber
    && nonEmptyString(item.tipId)
    && Number.isSafeInteger(item.sequence)
    && item.sequence >= 0
    && (
      item.sequence === 0
        ? parsed.successor === null && item.tipId === item.id
        : parsed.successor !== null
          && parsed.successor.rootCommentId === item.id
          && parsed.successor.sequence === item.sequence
    );
}

const SECTION_ITEM_VALIDATORS = Object.freeze({
  repo: (item) => hasExactKeys(
    item,
    ['owner', 'name', 'nameWithOwner', 'defaultBranch'],
  )
    && nonEmptyString(item.owner)
    && nonEmptyString(item.name)
    && item.nameWithOwner === `${item.owner}/${item.name}`
    && nonEmptyString(item.defaultBranch),
  tree: (item) => hasExactKeys(
    item,
    ['dirtyEntries', 'dirtyPaths', 'branch', 'headOid'],
  )
    && isDenseJsonArray(item.dirtyEntries)
    && item.dirtyEntries.every((entry) => typeof entry === 'string')
    && item.dirtyPaths === item.dirtyEntries.length
    && nonEmptyString(item.branch)
    && validObjectId(item.headOid),
  openPrs: validPullRequestItem,
  lifecycleMarkers: validLifecycleMarkerItem,
  queue: validQueueItem,
  blockedIssues: validIssueItem,
  openIssues: validIssueItem,
  mergedPrs: validPullRequestItem,
  unresolvedReviewThreads: validReviewThreadItem,
  authorVerification: validAuthorVerificationItem,
});

function validSnapshotSection(name, section, repositoryNameWithOwner = null) {
  if (!validSection(section)) return false;
  if (
    section.complete
    && ['repo', 'tree'].includes(name)
    && section.items.length !== 1
  ) {
    return false;
  }
  if (
    ['openPrs', 'mergedPrs'].includes(name)
    && section.items.length > 0
    && !nonEmptyString(repositoryNameWithOwner)
  ) {
    return false;
  }
  return section.items.every((item) =>
    SECTION_ITEM_VALIDATORS[name](item, section.complete, repositoryNameWithOwner));
}

function snapshotRepositoryName(sections) {
  const repo = sections?.repo;
  return validSnapshotSection('repo', repo) && repo.complete
    ? repo.items[0].nameWithOwner
    : null;
}

export function completeSection(items = []) {
  if (!isDenseJsonArray(items)) {
    return incompleteSection(
      'SECTION_ITEMS_INVALID',
      'complete snapshot sections require an item array',
    );
  }
  return {
    items,
    complete: true,
    error: null,
  };
}

export function incompleteSection(code, message, items = []) {
  return {
    items: isDenseJsonArray(items) ? items : [],
    complete: false,
    error: errorRecord(code, message),
  };
}

export function combineSections(sections) {
  if (!isDenseJsonArray(sections) || sections.some((section) => !validSection(section))) {
    return incompleteSection(
      'SECTION_COMBINATION_INVALID',
      'cannot combine invalid snapshot sections',
    );
  }
  const items = sections.flatMap((section) => section.items);
  const errors = sections
    .filter((section) => section.complete !== true)
    .map((section) => `${section.error.code}: ${section.error.message}`);
  return errors.length
    ? incompleteSection(
      'DEPENDENT_SECTION_INCOMPLETE',
      errors.join('; '),
      items,
    )
    : completeSection(items);
}

export async function collectPaginated(
  fetchPage,
  { maxPages = 100, maxItems = 10000 } = {},
) {
  if (
    typeof fetchPage !== 'function'
    || !Number.isSafeInteger(maxPages)
    || maxPages < 1
    || !Number.isSafeInteger(maxItems)
    || maxItems < 1
  ) {
    return incompleteSection('PAGINATION_INPUT_INVALID', 'invalid pagination contract');
  }
  const items = [];
  const seen = new Set();
  let cursor = null;
  for (let page = 1; page <= maxPages; page += 1) {
    let response;
    try {
      response = await fetchPage(cursor, page);
    } catch (error) {
      return incompleteSection(
        'PAGE_FETCH_FAILED',
        String(error?.message ?? error),
        items,
      );
    }
    if (
      !response
      || typeof response !== 'object'
      || !isDenseJsonArray(response.items)
      || !(
        response.nextCursor === null
        || (typeof response.nextCursor === 'string' && response.nextCursor.length > 0)
      )
    ) {
      return incompleteSection(
        'PAGE_SHAPE_INVALID',
        `page ${page} did not provide items and a cursor`,
        items,
      );
    }
    items.push(...response.items);
    if (items.length > maxItems) {
      return incompleteSection(
        'PAGINATION_LIMIT',
        `pagination exceeded ${maxItems} items`,
        items.slice(0, maxItems),
      );
    }
    if (response.nextCursor === null) return completeSection(items);
    if (seen.has(response.nextCursor)) {
      return incompleteSection(
        'PAGINATION_CURSOR_REPEATED',
        `page ${page} repeated a pagination cursor`,
        items,
      );
    }
    seen.add(response.nextCursor);
    cursor = response.nextCursor;
  }
  return incompleteSection(
    'PAGINATION_LIMIT',
    `pagination exceeded ${maxPages} pages`,
    items,
  );
}

export async function mapBounded(values, concurrency, worker) {
  if (
    !isDenseJsonArray(values)
    || !Number.isSafeInteger(concurrency)
    || concurrency < 1
    || typeof worker !== 'function'
  ) {
    throw new TypeError('invalid bounded-map contract');
  }
  const results = new Array(values.length);
  let next = 0;
  const run = async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await worker(values[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, run),
  );
  return results;
}

export function createLimiter(concurrency) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new TypeError('invalid concurrency limit');
  }
  let active = 0;
  const waiting = [];
  return async (worker) => {
    if (typeof worker !== 'function') throw new TypeError('limited work must be a function');
    await new Promise((resolve) => {
      const acquire = () => {
        active += 1;
        resolve();
      };
      if (active < concurrency) acquire();
      else waiting.push(acquire);
    });
    try {
      return await worker();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

export function issueSnapshotItem(issue = {}) {
  const labels = Array.isArray(issue.labels)
    ? issue.labels
      .map((label) => typeof label === 'string' ? label : label?.name)
      .filter((label) => typeof label === 'string' && label.length > 0)
    : [];
  const body = typeof issue.body === 'string' ? issue.body : '';
  return {
    number: Number.isSafeInteger(issue.number) && issue.number > 0 ? issue.number : null,
    title: typeof issue.title === 'string' ? issue.title : '',
    body,
    bodySha256: sha256Text(body),
    updatedAt: typeof issue.updatedAt === 'string' ? issue.updatedAt : null,
    lastEditedAt: typeof issue.lastEditedAt === 'string' ? issue.lastEditedAt : null,
    labels: [...new Set(labels)].sort(),
  };
}

export function lifecycleMarkerSnapshotItem(
  comment = {},
  issueNumber = null,
  chain = {},
) {
  const root = chain.root ?? comment;
  const sequence = Number.isSafeInteger(chain.sequence)
    ? chain.sequence
    : 0;
  return {
    issueNumber: Number.isSafeInteger(issueNumber) && issueNumber > 0 ? issueNumber : null,
    id: typeof root.id === 'string' ? root.id : null,
    tipId: typeof comment.id === 'string' ? comment.id : null,
    sequence,
    author: comment.author?.login ?? null,
    authorAssociation: comment.authorAssociation ?? null,
    body: typeof comment.body === 'string' ? comment.body : '',
    createdAt: root.createdAt ?? null,
    updatedAt: comment.updatedAt ?? comment.lastEditedAt ?? null,
    url: root.url ?? null,
  };
}

function snapshotFingerprint(snapshot) {
  const { fingerprint: ignoredFingerprint, ...content } = snapshot;
  return sha256(content);
}

function snapshotGeneration(scannedAt, sections) {
  return sha256({
    kind: 'autoloop-snapshot-generation',
    version: SNAPSHOT_VERSION,
    scannedAt,
    items: Object.fromEntries(
      SNAPSHOT_SECTIONS.map((name) => [name, sections[name].items]),
    ),
  });
}

function sortedUniqueStrings(values) {
  return [...new Set(values)].sort();
}

export function createSnapshot({ scannedAt, sections } = {}) {
  const timestampValid = validTimestamp(scannedAt);
  const normalizedScannedAt = timestampValid ? scannedAt : new Date(0).toISOString();
  const repositoryNameWithOwner = snapshotRepositoryName(sections);
  const normalizedSections = Object.fromEntries(
    SNAPSHOT_SECTIONS.map((name) => [
      name,
      timestampValid && validSnapshotSection(
        name,
        sections?.[name],
        repositoryNameWithOwner,
      )
        ? sections[name]
        : incompleteSection(
          timestampValid ? 'SNAPSHOT_SECTION_INVALID' : 'SNAPSHOT_TIMESTAMP_INVALID',
          timestampValid
            ? `${name} section is missing or invalid`
            : 'snapshot timestamp is missing or invalid',
        ),
    ]),
  );
  const snapshot = {
    kind: 'autoloop-repository-snapshot',
    version: SNAPSHOT_VERSION,
    scannedAt: normalizedScannedAt,
    generation: snapshotGeneration(normalizedScannedAt, normalizedSections),
    sections: normalizedSections,
    invalidation: { reasonCodes: [], sections: [] },
    fingerprint: '',
  };
  snapshot.fingerprint = snapshotFingerprint(snapshot);
  return deepFreeze(snapshot);
}

export function verifySnapshot(snapshot) {
  try {
    const repositoryNameWithOwner = snapshotRepositoryName(snapshot?.sections);
    if (
      !hasExactKeys(snapshot, SNAPSHOT_KEYS)
      || snapshot.kind !== 'autoloop-repository-snapshot'
      || snapshot.version !== SNAPSHOT_VERSION
      || !validTimestamp(snapshot.scannedAt)
      || !/^[0-9a-f]{64}$/.test(snapshot.generation)
      || !/^[0-9a-f]{64}$/.test(snapshot.fingerprint)
      || !hasExactKeys(snapshot.sections, SNAPSHOT_SECTIONS)
      || !SNAPSHOT_SECTIONS.every((name) =>
        validSnapshotSection(name, snapshot.sections[name], repositoryNameWithOwner))
      || snapshot.generation !== snapshotGeneration(snapshot.scannedAt, snapshot.sections)
      || !hasExactKeys(snapshot.invalidation, INVALIDATION_KEYS)
      || !isDenseJsonArray(snapshot.invalidation.reasonCodes)
      || !isDenseJsonArray(snapshot.invalidation.sections)
      || !snapshot.invalidation.reasonCodes.every((reason) =>
        SNAPSHOT_INVALIDATION_REASONS.includes(reason))
      || !snapshot.invalidation.sections.every((name) => SNAPSHOT_SECTIONS.includes(name))
      || stableJson(sortedUniqueStrings(snapshot.invalidation.reasonCodes))
        !== stableJson(snapshot.invalidation.reasonCodes)
      || stableJson(sortedUniqueStrings(snapshot.invalidation.sections))
        !== stableJson(snapshot.invalidation.sections)
    ) {
      return false;
    }
    const invalidatedSections = sortedUniqueStrings(
      snapshot.invalidation.reasonCodes.flatMap((reason) => INVALIDATED_SECTIONS[reason]),
    );
    if (
      stableJson(invalidatedSections) !== stableJson(snapshot.invalidation.sections)
      || invalidatedSections.some((name) =>
        snapshot.sections[name].complete !== false
        || snapshot.sections[name].error.code !== 'SNAPSHOT_INVALIDATED')
    ) {
      return false;
    }
    return snapshotFingerprint(snapshot) === snapshot.fingerprint;
  } catch {
    return false;
  }
}

export function invalidateSnapshot(snapshot, reasonCode) {
  if (!verifySnapshot(snapshot)) throw new TypeError('cannot invalidate an invalid snapshot');
  if (!SNAPSHOT_INVALIDATION_REASONS.includes(reasonCode)) {
    throw new TypeError('unknown snapshot invalidation reason');
  }
  const affected = INVALIDATED_SECTIONS[reasonCode];
  const sections = Object.fromEntries(
    SNAPSHOT_SECTIONS.map((name) => {
      const section = snapshot.sections[name];
      return [
        name,
        affected.includes(name)
          ? incompleteSection(
            'SNAPSHOT_INVALIDATED',
            `${name} invalidated by ${reasonCode}`,
            section.items,
          )
          : section,
      ];
    }),
  );
  const invalidated = {
    ...snapshot,
    sections,
    invalidation: {
      reasonCodes: sortedUniqueStrings([
        ...snapshot.invalidation.reasonCodes,
        reasonCode,
      ]),
      sections: sortedUniqueStrings([
        ...snapshot.invalidation.sections,
        ...affected,
      ]),
    },
    fingerprint: '',
  };
  invalidated.fingerprint = snapshotFingerprint(invalidated);
  return deepFreeze(invalidated);
}

export function absenceDecision(snapshot, sectionNames, matches) {
  if (
    !verifySnapshot(snapshot)
    || !isDenseJsonArray(sectionNames)
    || sectionNames.length === 0
    || sectionNames.some((name) => !SNAPSHOT_SECTIONS.includes(name))
    || new Set(sectionNames).size !== sectionNames.length
    || typeof matches !== 'function'
  ) {
    return {
      ok: false,
      reasonCodes: ['SNAPSHOT_ABSENCE_INPUT_INVALID'],
      incompleteSections: [],
    };
  }
  const incompleteSections = sectionNames
    .filter((name) => snapshot.sections[name].complete !== true)
    .sort();
  if (incompleteSections.length) {
    return {
      ok: false,
      reasonCodes: ['SNAPSHOT_SECTION_INCOMPLETE'],
      incompleteSections,
    };
  }
  try {
    for (const name of sectionNames) {
      if (snapshot.sections[name].items.some((item) => matches(item, name))) {
        return {
          ok: false,
          reasonCodes: ['SNAPSHOT_ITEM_PRESENT'],
          incompleteSections: [],
        };
      }
    }
  } catch {
    return {
      ok: false,
      reasonCodes: ['SNAPSHOT_ABSENCE_INPUT_INVALID'],
      incompleteSections: [],
    };
  }
  return { ok: true, reasonCodes: [], incompleteSections: [] };
}

export function repositoryAbsenceDecision(snapshot, purpose, matches) {
  const sections = SNAPSHOT_ABSENCE_REQUIREMENTS[purpose];
  if (!sections) {
    return {
      ok: false,
      reasonCodes: ['SNAPSHOT_ABSENCE_PURPOSE_INVALID'],
      incompleteSections: [],
    };
  }
  return absenceDecision(snapshot, sections, matches);
}

function eligibleQueueIssueNumbers(snapshot) {
  const blocked = new Set(snapshot.sections.blockedIssues.items.map((issue) => issue.number));
  const owned = new Set([
    ...snapshot.sections.openPrs.items,
    ...snapshot.sections.mergedPrs.items,
  ]
    .filter((pr) => pr.ownership === 'loop' && positiveInteger(pr.issue))
    .map((pr) => pr.issue));
  const recovering = new Set(
    snapshot.sections.lifecycleMarkers.items.map((marker) => marker.issueNumber),
  );
  return snapshot.sections.queue.items
    .filter((issue) => {
      const labeledBy = issue.provenance?.labeledBy;
      const labeledAt = issue.provenance?.labeledAt;
      const trusted = snapshot.sections.authorVerification.items.some((author) =>
        author.login === labeledBy
        && ['admin', 'write'].includes(author.permission)
        && author.evidence.some((evidence) =>
          evidence.kind === 'queue-label'
          && evidence.issueNumber === issue.number
          && evidence.author === labeledBy
          && evidence.createdAt === labeledAt));
      const bodyUnchanged = issue.lastEditedAt === null
        || Date.parse(issue.lastEditedAt) <= Date.parse(labeledAt);
      return trusted
        && bodyUnchanged
        && !blocked.has(issue.number)
        && !issue.labels.includes('loop-blocked')
        && !owned.has(issue.number)
        && !recovering.has(issue.number)
        && issue.dependencies.every((dependency) => dependency.state === 'CLOSED');
    })
    .map((issue) => issue.number)
    .sort((left, right) => left - right);
}

function queueEvidenceFingerprint(evidence) {
  const { fingerprint: ignoredFingerprint, ...content } = evidence;
  return sha256(content);
}

export function createQueueEvidence({
  snapshot,
  purpose,
  runInstanceFingerprint,
  configFingerprint,
  configuredBaseBranch,
} = {}) {
  const purposeSections = SNAPSHOT_ABSENCE_REQUIREMENTS[purpose];
  const requiredSections = purposeSections
    ? sortedUniqueStrings(['repo', 'tree', ...purposeSections])
    : null;
  if (
    !verifySnapshot(snapshot)
    || !['queueExhaustion', 'relaunch'].includes(purpose)
    || requiredSections === null
    || !/^[0-9a-f]{64}$/u.test(runInstanceFingerprint ?? '')
    || !/^[0-9a-f]{64}$/u.test(configFingerprint ?? '')
    || !nonEmptyString(configuredBaseBranch)
    || snapshot.invalidation.reasonCodes.length !== 0
    || requiredSections.some((name) => snapshot.sections[name].complete !== true)
  ) {
    throw new TypeError('queue evidence requires one complete current repository snapshot');
  }
  const repository = snapshot.sections.repo.items[0];
  const tree = snapshot.sections.tree.items[0];
  if (
    repository.defaultBranch !== configuredBaseBranch
    || tree.branch !== configuredBaseBranch
    || tree.dirtyPaths !== 0
  ) {
    throw new TypeError('queue evidence requires a clean configured-base snapshot');
  }
  const evidence = {
    kind: 'autoloop-queue-evidence',
    version: QUEUE_EVIDENCE_VERSION,
    purpose,
    runInstanceFingerprint,
    configFingerprint,
    configuredBaseBranch,
    repositoryNameWithOwner: repository.nameWithOwner,
    repositoryFingerprint: sha256({
      defaultBranch: repository.defaultBranch,
      nameWithOwner: repository.nameWithOwner,
    }),
    snapshotGeneration: snapshot.generation,
    snapshotFingerprint: snapshot.fingerprint,
    requiredSections,
    eligibleIssueNumbers: eligibleQueueIssueNumbers(snapshot),
    fingerprint: '',
  };
  evidence.fingerprint = queueEvidenceFingerprint(evidence);
  return deepFreeze(evidence);
}

export function verifyQueueEvidence(evidence, snapshot, run) {
  try {
    if (
      !hasExactKeys(evidence, QUEUE_EVIDENCE_KEYS)
      || !['queueExhaustion', 'relaunch'].includes(evidence.purpose)
      || evidence.kind !== 'autoloop-queue-evidence'
      || evidence.version !== QUEUE_EVIDENCE_VERSION
      || !/^[0-9a-f]{64}$/u.test(evidence.fingerprint)
      || !isDenseJsonArray(evidence.requiredSections)
      || !isDenseJsonArray(evidence.eligibleIssueNumbers)
      || evidence.eligibleIssueNumbers.some((number) => !positiveInteger(number))
      || new Set(evidence.eligibleIssueNumbers).size !== evidence.eligibleIssueNumbers.length
    ) {
      return false;
    }
    const expected = createQueueEvidence({
      snapshot,
      purpose: evidence.purpose,
      runInstanceFingerprint: run?.instanceFingerprint,
      configFingerprint: run?.configFingerprint,
      configuredBaseBranch: run?.configuredBaseBranch,
    });
    return stableJson(expected) === stableJson(evidence)
      && queueEvidenceFingerprint(evidence) === evidence.fingerprint;
  } catch {
    return false;
  }
}

export function blockerResolutionDecision(snapshot, issueNumber) {
  const result = (ok, reasonCodes, openDependencies = []) => ({
    ok,
    reasonCodes,
    openDependencies,
  });
  if (!verifySnapshot(snapshot) || !positiveInteger(issueNumber)) {
    return result(false, ['SNAPSHOT_BLOCKER_INPUT_INVALID']);
  }
  if (snapshot.sections.queue.complete !== true) {
    return result(false, ['SNAPSHOT_SECTION_INCOMPLETE']);
  }
  const candidates = snapshot.sections.queue.items
    .filter((item) => item.number === issueNumber);
  if (candidates.length !== 1) {
    return result(false, [
      candidates.length === 0
        ? 'SNAPSHOT_QUEUE_ITEM_MISSING'
        : 'SNAPSHOT_QUEUE_ITEM_AMBIGUOUS',
    ]);
  }
  const openDependencies = candidates[0].dependencies
    .filter((dependency) => dependency.state !== 'CLOSED')
    .map((dependency) => dependency.number);
  return openDependencies.length === 0
    ? result(true, [])
    : result(false, ['SNAPSHOT_DEPENDENCY_OPEN'], openDependencies);
}

function parseArgs(args) {
  if (args.length === 1 && args[0] === '--self-test') {
    return { mode: 'self-test', error: null };
  }
  if (
    args.length === 2
    && args[0] === '--invalidate'
    && SNAPSHOT_INVALIDATION_REASONS.includes(args[1])
  ) {
    return { mode: 'invalidate', reasonCode: args[1], error: null };
  }
  if (
    args.length === 5
    && args[0] === '--queue-evidence'
    && ['queueExhaustion', 'relaunch'].includes(args[1])
  ) {
    return {
      mode: 'queue-evidence',
      purpose: args[1],
      runInstanceFingerprint: args[2],
      configFingerprint: args[3],
      configuredBaseBranch: args[4],
      error: null,
    };
  }
  return {
    mode: null,
    error:
      'expected --self-test, --invalidate '
      + `<${SNAPSHOT_INVALIDATION_REASONS.join('|')}>, or `
      + '--queue-evidence <queueExhaustion|relaunch> <run hash> <config hash> <base>',
  };
}

function readSnapshotInput() {
  const source = readFileSync(0, 'utf8');
  if (Buffer.byteLength(source) > 64 * 1024 * 1024) {
    throw new Error('snapshot input exceeds 64 MiB');
  }
  return JSON.parse(source);
}

async function selfTest() {
  const checks = [];
  const check = async (name, test) => {
    try {
      checks.push([name, await test()]);
    } catch {
      checks.push([name, false]);
    }
  };
  await check(
    'a large payload survives a piped stdout and an immediate exit intact',
    () => {
      const source = [
        `import { writeStdoutSync } from ${JSON.stringify(import.meta.url)};`,
        "writeStdoutSync('x'.repeat(400000));",
        'process.exit(0);',
      ].join('\n');
      const result = spawnSync(
        process.execPath,
        ['--input-type=module', '--eval', source],
        { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 30000 },
      );
      return result.status === 0 && result.stdout.length === 400000;
    },
  );
  const pullRequestItem = (overrides = {}) => ({
    number: 8,
    title: 'loop unit',
    body: 'Closes #7',
    isDraft: false,
    reviewDecision: 'APPROVED',
    headRefName: 'feat/gh-7-loop-unit',
    headRefOid: 'a'.repeat(40),
    baseRefName: 'main',
    mergeStateStatus: 'CLEAN',
    mergeable: 'MERGEABLE',
    mergedAt: null,
    updatedAt: '2026-01-01T00:00:00Z',
    author: 'actor',
    headRepository: 'owner/repo',
    statusCheckState: 'SUCCESS',
    statusCheckRollup: [{
      kind: 'check-run',
      name: 'ci',
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
      detailsUrl: null,
    }],
    issue: 7,
    orphanCandidate: false,
    ownership: 'loop',
    ...overrides,
  });
  const lifecycleMarkerItem = (overrides = {}) => ({
    issueNumber: 7,
    id: 'IC_lifecycle',
    tipId: 'IC_lifecycle',
    sequence: 0,
    author: 'autoloop',
    authorAssociation: 'MEMBER',
    body: '<!-- autoloop-lifecycle-v1\n{"branch":"feat/gh-7-contract","intentSource":"invocation","issue":7,"issueBodyHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","mergePolicy":"manual","phase":"intent-recorded","planHash":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","plannedBaseOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","runIntentHash":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","selector":"native","v":1}\n-->',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    url: 'https://example.test/issues/7#issuecomment-1',
    ...overrides,
  });
  const queueSnapshot = ({ blocked = false, incomplete = null } = {}) => {
    const sections = Object.fromEntries(
      SNAPSHOT_SECTIONS.map((name) => [name, completeSection([])]),
    );
    const issue = issueSnapshotItem({
      number: 7,
      title: 'queued',
      body: 'body',
      updatedAt: '2026-01-01T00:00:00Z',
      lastEditedAt: null,
      labels: ['loop-ready', ...(blocked ? ['loop-blocked'] : [])],
    });
    sections.repo = completeSection([{
      owner: 'owner',
      name: 'repo',
      nameWithOwner: 'owner/repo',
      defaultBranch: 'main',
    }]);
    sections.tree = completeSection([{
      dirtyEntries: [],
      dirtyPaths: 0,
      branch: 'main',
      headOid: 'a'.repeat(40),
    }]);
    sections.queue = completeSection([{
      ...issue,
      blockedBy: [],
      dependencies: [],
      provenance: {
        labeledBy: 'maintainer',
        labeledAt: '2026-01-01T00:00:01Z',
      },
    }]);
    sections.openIssues = completeSection([issue]);
    sections.blockedIssues = completeSection(blocked ? [issue] : []);
    sections.authorVerification = completeSection([{
      login: 'maintainer',
      roleName: 'maintain',
      permission: 'write',
      evidence: [{
        kind: 'queue-label',
        issueNumber: 7,
        author: 'maintainer',
        authorAssociation: null,
        body: '',
        createdAt: '2026-01-01T00:00:01Z',
        updatedAt: null,
        url: null,
      }],
    }]);
    if (incomplete !== null) {
      sections[incomplete] = incompleteSection('PAGE_FETCH_FAILED', 'offline');
    }
    return createSnapshot({
      scannedAt: '2026-01-01T00:00:02.000Z',
      sections,
    });
  };
  const queueRun = {
    instanceFingerprint: 'b'.repeat(64),
    configFingerprint: 'c'.repeat(64),
    configuredBaseBranch: 'main',
  };

  await check('pagination reaches the terminal page', async () => {
    const pages = new Map([
      [null, { items: [1, 2], nextCursor: 'a' }],
      ['a', { items: [3], nextCursor: null }],
    ]);
    const result = await collectPaginated((cursor) => pages.get(cursor));
    return result.complete && result.items.join(',') === '1,2,3' && result.error === null;
  });
  await check('pagination cap is incomplete', async () => {
    const result = await collectPaginated(
      (cursor, page) => ({
        items: [cursor ?? 'first'],
        nextCursor: `page-${page}`,
      }),
      { maxPages: 2 },
    );
    return !result.complete && result.error?.code === 'PAGINATION_LIMIT';
  });
  await check('pagination error retains partial evidence', async () => {
    let page = 0;
    const result = await collectPaginated(() => {
      page += 1;
      if (page === 2) throw new Error('offline');
      return { items: ['seen'], nextCursor: 'more' };
    });
    return !result.complete
      && result.items[0] === 'seen'
      && result.error?.code === 'PAGE_FETCH_FAILED';
  });
  await check('bounded map preserves order and concurrency ceiling', async () => {
    let active = 0;
    let peak = 0;
    const values = await mapBounded([3, 2, 1, 0], 2, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, value));
      active -= 1;
      return value * 2;
    });
    return values.join(',') === '6,4,2,0' && peak === 2;
  });
  await check('shared limiter bounds nested command sources', async () => {
    let active = 0;
    let peak = 0;
    const limit = createLimiter(2);
    await Promise.all([3, 2, 1, 0].map((delay) => limit(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, delay));
      active -= 1;
    })));
    return peak === 2;
  });
  await check('body edit changes durable hashes', () => {
    const before = issueSnapshotItem({
      number: 7,
      title: 'x',
      body: 'before',
      updatedAt: '2026-01-01T00:00:00Z',
      lastEditedAt: '2026-01-01T00:00:00Z',
      labels: [],
    });
    const after = issueSnapshotItem({ ...before, body: 'after' });
    const beforeSections = Object.fromEntries(
      SNAPSHOT_SECTIONS.map((name) => [name, completeSection([])]),
    );
    const afterSections = { ...beforeSections };
    beforeSections.openIssues = completeSection([before]);
    afterSections.openIssues = completeSection([after]);
    const beforeSnapshot = createSnapshot({
      scannedAt: '2026-01-01T00:00:00.000Z',
      sections: beforeSections,
    });
    const afterSnapshot = createSnapshot({
      scannedAt: '2026-01-01T00:00:00.000Z',
      sections: afterSections,
    });
    return before.bodySha256 !== after.bodySha256
      && after.lastEditedAt === before.lastEditedAt
      && beforeSnapshot.generation !== afterSnapshot.generation
      && beforeSnapshot.fingerprint !== afterSnapshot.fingerprint;
  });
  await check('snapshot is versioned and fingerprinted', () => {
    const snapshot = createSnapshot({
      scannedAt: '2026-01-01T00:00:00.000Z',
      sections: Object.fromEntries(SNAPSHOT_SECTIONS.map((name) => [name, completeSection([])])),
    });
    return snapshot.version === SNAPSHOT_VERSION
      && /^[0-9a-f]{64}$/.test(snapshot.generation)
      && /^[0-9a-f]{64}$/.test(snapshot.fingerprint)
      && verifySnapshot(snapshot);
  });
  await check('queue evidence derives eligible IDs and binds the run and repository', () => {
    const snapshot = queueSnapshot();
    const evidence = createQueueEvidence({
      snapshot,
      purpose: 'relaunch',
      runInstanceFingerprint: queueRun.instanceFingerprint,
      configFingerprint: queueRun.configFingerprint,
      configuredBaseBranch: queueRun.configuredBaseBranch,
    });
    return stableJson(evidence.eligibleIssueNumbers) === stableJson([7])
      && evidence.repositoryNameWithOwner === 'owner/repo'
      && verifyQueueEvidence(evidence, snapshot, queueRun)
      && !verifyQueueEvidence(evidence, snapshot, {
        ...queueRun,
        instanceFingerprint: 'd'.repeat(64),
      });
  });
  await check('queue evidence excludes blocked work without calling it absent', () => {
    const snapshot = queueSnapshot({ blocked: true });
    const evidence = createQueueEvidence({
      snapshot,
      purpose: 'queueExhaustion',
      runInstanceFingerprint: queueRun.instanceFingerprint,
      configFingerprint: queueRun.configFingerprint,
      configuredBaseBranch: queueRun.configuredBaseBranch,
    });
    return evidence.eligibleIssueNumbers.length === 0
      && snapshot.sections.queue.items.length === 1
      && verifyQueueEvidence(evidence, snapshot, queueRun);
  });
  await check('queue evidence rejects incomplete or invalidated snapshots', () => {
    const incomplete = queueSnapshot({ incomplete: 'openIssues' });
    const invalidated = invalidateSnapshot(queueSnapshot(), 'WAIT_BOUNDARY');
    for (const snapshot of [incomplete, invalidated]) {
      try {
        createQueueEvidence({
          snapshot,
          purpose: 'queueExhaustion',
          runInstanceFingerprint: queueRun.instanceFingerprint,
          configFingerprint: queueRun.configFingerprint,
          configuredBaseBranch: queueRun.configuredBaseBranch,
        });
        return false;
      } catch {
        continue;
      }
    }
    return true;
  });
  await check('queue evidence rejects tampered derived IDs', () => {
    const snapshot = queueSnapshot();
    const evidence = createQueueEvidence({
      snapshot,
      purpose: 'relaunch',
      runInstanceFingerprint: queueRun.instanceFingerprint,
      configFingerprint: queueRun.configFingerprint,
      configuredBaseBranch: queueRun.configuredBaseBranch,
    });
    return !verifyQueueEvidence({
      ...evidence,
      eligibleIssueNumbers: [],
    }, snapshot, queueRun);
  });
  await check('mutation invalidates only affected sections with a reason', () => {
    const sections = Object.fromEntries(
      SNAPSHOT_SECTIONS.map((name) => [name, completeSection([])]),
    );
    sections.repo = completeSection([{
      owner: 'example',
      name: 'repo',
      nameWithOwner: 'example/repo',
      defaultBranch: 'main',
    }]);
    sections.tree = completeSection([{
      dirtyEntries: [],
      dirtyPaths: 0,
      branch: 'main',
      headOid: 'a'.repeat(40),
    }]);
    const snapshot = createSnapshot({
      scannedAt: '2026-01-01T00:00:00.000Z',
      sections,
    });
    const invalidated = invalidateSnapshot(snapshot, 'ISSUE_MUTATION');
    return invalidated.sections.queue.complete === false
      && invalidated.sections.openIssues.complete === false
      && invalidated.sections.lifecycleMarkers.complete === false
      && invalidated.sections.tree.complete === true
      && invalidated.invalidation.reasonCodes.includes('ISSUE_MUTATION')
      && invalidated.generation === snapshot.generation
      && invalidated.fingerprint !== snapshot.fingerprint
      && verifySnapshot(invalidated);
  });
  await check('typed invalidation CLI accepts only closed reason codes', () => {
    const accepted = parseArgs(['--invalidate', 'PR_MUTATION']);
    const rejected = parseArgs(['--invalidate', 'SOMETHING_CHANGED']);
    return accepted.mode === 'invalidate'
      && accepted.reasonCode === 'PR_MUTATION'
      && accepted.error === null
      && rejected.mode === null
      && rejected.error !== null;
  });
  await check('queue-evidence CLI requires closed purpose and explicit bindings', () => {
    const accepted = parseArgs([
      '--queue-evidence',
      'relaunch',
      'a'.repeat(64),
      'b'.repeat(64),
      'main',
    ]);
    const rejected = parseArgs([
      '--queue-evidence',
      'something',
      'a'.repeat(64),
      'b'.repeat(64),
      'main',
    ]);
    return accepted.mode === 'queue-evidence'
      && accepted.purpose === 'relaunch'
      && rejected.error !== null;
  });
  await check('incomplete section rejects an absence conclusion', () => {
    const sections = Object.fromEntries(SNAPSHOT_SECTIONS.map((name) => [name, completeSection([])]));
    sections.queue = incompleteSection('PAGE_FETCH_FAILED', 'offline');
    const snapshot = createSnapshot({
      scannedAt: '2026-01-01T00:00:00.000Z',
      sections,
    });
    const result = absenceDecision(snapshot, ['queue'], () => false);
    return !result.ok
      && result.reasonCodes.includes('SNAPSHOT_SECTION_INCOMPLETE')
      && result.incompleteSections[0] === 'queue';
  });
  await check('malformed section items cannot become complete absence', () => {
    const malformed = completeSection(null);
    return malformed.complete === false
      && malformed.error?.code === 'SECTION_ITEMS_INVALID';
  });
  await check('malformed typed items make their section incomplete', () => {
    const sections = Object.fromEntries(
      SNAPSHOT_SECTIONS.map((name) => [name, completeSection([])]),
    );
    sections.openIssues = completeSection([null]);
    const snapshot = createSnapshot({
      scannedAt: '2026-01-01T00:00:00.000Z',
      sections,
    });
    const absence = repositoryAbsenceDecision(snapshot, 'selection', () => false);
    return snapshot.sections.openIssues.complete === false
      && snapshot.sections.openIssues.error?.code === 'SNAPSHOT_SECTION_INVALID'
      && absence.ok === false
      && absence.incompleteSections.includes('openIssues');
  });
  await check('anonymous lifecycle markers cannot become authoritative', () => {
    const sections = Object.fromEntries(
      SNAPSHOT_SECTIONS.map((name) => [name, completeSection([])]),
    );
    sections.lifecycleMarkers = completeSection([lifecycleMarkerItem({ author: null })]);
    const snapshot = createSnapshot({
      scannedAt: '2026-01-01T00:00:00.000Z',
      sections,
    });
    return snapshot.sections.lifecycleMarkers.complete === false
      && snapshot.sections.lifecycleMarkers.error?.code === 'SNAPSHOT_SECTION_INVALID';
  });
  await check('typed hashes reject string-coercible objects', () => {
    const sections = Object.fromEntries(
      SNAPSHOT_SECTIONS.map((name) => [name, completeSection([])]),
    );
    sections.openIssues = completeSection([{
      ...issueSnapshotItem({
        number: 7,
        title: 'typed',
        body: 'body',
        updatedAt: '2026-01-01T00:00:00Z',
        lastEditedAt: null,
        labels: [],
      }),
      bodySha256: { toString: () => 'a'.repeat(64) },
    }]);
    const snapshot = createSnapshot({
      scannedAt: '2026-01-01T00:00:00.000Z',
      sections,
    });
    return snapshot.sections.openIssues.complete === false;
  });
  await check('issue body hashes are recomputed before proving completeness', () => {
    const sections = Object.fromEntries(
      SNAPSHOT_SECTIONS.map((name) => [name, completeSection([])]),
    );
    sections.openIssues = completeSection([{
      ...issueSnapshotItem({
        number: 7,
        title: 'provenance',
        body: 'actual',
        updatedAt: '2026-01-01T00:00:00Z',
        lastEditedAt: null,
        labels: [],
      }),
      bodySha256: '0'.repeat(64),
    }]);
    const snapshot = createSnapshot({
      scannedAt: '2026-01-01T00:00:00.000Z',
      sections,
    });
    return snapshot.sections.openIssues.complete === false
      && verifySnapshot(snapshot)
      && repositoryAbsenceDecision(snapshot, 'selection', () => false).ok === false;
  });
  await check('section item schemas reject unknown fields', () => {
    const sections = Object.fromEntries(
      SNAPSHOT_SECTIONS.map((name) => [name, completeSection([])]),
    );
    sections.openIssues = completeSection([{
      ...issueSnapshotItem({
        number: 7,
        title: 'strict',
        body: 'body',
        updatedAt: '2026-01-01T00:00:00Z',
        lastEditedAt: null,
        labels: [],
      }),
      smuggledAuthority: true,
    }]);
    const snapshot = createSnapshot({
      scannedAt: '2026-01-01T00:00:00.000Z',
      sections,
    });
    return snapshot.sections.openIssues.complete === false;
  });
  await check('GitHub actionability enums are closed and kind-specific', () => {
    const validSections = Object.fromEntries(
      SNAPSHOT_SECTIONS.map((name) => [name, completeSection([])]),
    );
    validSections.repo = completeSection([{
      owner: 'owner',
      name: 'repo',
      nameWithOwner: 'owner/repo',
      defaultBranch: 'main',
    }]);
    validSections.openPrs = completeSection([pullRequestItem()]);
    const valid = createSnapshot({
      scannedAt: '2026-01-01T00:00:00.000Z',
      sections: validSections,
    });
    const invalidSections = { ...validSections };
    invalidSections.openPrs = completeSection([pullRequestItem({
      reviewDecision: 'BOGUS',
      mergeStateStatus: 'BOGUS',
      mergeable: 'BOGUS',
      statusCheckState: 'BOGUS',
      statusCheckRollup: [{
        kind: 'check-run',
        name: 'ci',
        status: 'BOGUS',
        conclusion: 'BOGUS',
        detailsUrl: null,
      }],
    })]);
    const invalid = createSnapshot({
      scannedAt: '2026-01-01T00:00:00.000Z',
      sections: invalidSections,
    });
    return valid.sections.openPrs.complete === true
      && invalid.sections.openPrs.complete === false;
  });
  await check('sparse and serialization-active arrays fail closed', () => {
    const sparse = new Array(1);
    const hugeSparse = [];
    hugeSparse.length = 2 ** 32 - 1;
    const active = [];
    Object.defineProperty(active, 'toJSON', {
      value: () => [null],
    });
    return completeSection(sparse).complete === false
      && completeSection(hugeSparse).complete === false
      && completeSection(active).complete === false;
  });
  await check('serialization-active records fail closed before fingerprinting', () => {
    const inherited = Object.create({ toJSON: () => null });
    Object.assign(inherited, {
      owner: 'owner',
      name: 'repo',
      nameWithOwner: 'owner/repo',
      defaultBranch: 'main',
    });
    const hidden = {
      owner: 'owner',
      name: 'repo',
      nameWithOwner: 'owner/repo',
      defaultBranch: 'main',
    };
    Object.defineProperty(hidden, 'toJSON', {
      value: () => null,
    });
    return [inherited, hidden].every((item) => {
      const sections = Object.fromEntries(
        SNAPSHOT_SECTIONS.map((name) => [name, completeSection([])]),
      );
      sections.repo = completeSection([item]);
      const snapshot = createSnapshot({
        scannedAt: '2026-01-01T00:00:00.000Z',
        sections,
      });
      return snapshot.sections.repo.complete === false
        && verifySnapshot(snapshot)
        && verifySnapshot(JSON.parse(JSON.stringify(snapshot)));
    });
  });
  await check('freshness timestamps require canonical GitHub UTC values', () => {
    const sections = Object.fromEntries(
      SNAPSHOT_SECTIONS.map((name) => [name, completeSection([])]),
    );
    sections.openIssues = completeSection([issueSnapshotItem({
      number: 7,
      title: 'timestamp',
      body: 'body',
      updatedAt: '1',
      lastEditedAt: null,
      labels: [],
    })]);
    const snapshot = createSnapshot({
      scannedAt: '2026-01-01T00:00:00.000Z',
      sections,
    });
    return snapshot.sections.openIssues.complete === false
      && !validDateTime('2026-02-30T00:00:00Z')
      && validDateTime('2026-02-28T00:00:00Z')
      && validDateTime('2026-02-28T00:00:00.12Z');
  });
  await check('Git object IDs accept only exact SHA-1 or SHA-256 lengths', () => {
    const sections = Object.fromEntries(
      SNAPSHOT_SECTIONS.map((name) => [name, completeSection([])]),
    );
    sections.tree = completeSection([{
      dirtyEntries: [],
      dirtyPaths: 0,
      branch: 'main',
      headOid: 'a'.repeat(41),
    }]);
    const snapshot = createSnapshot({
      scannedAt: '2026-01-01T00:00:00.000Z',
      sections,
    });
    return snapshot.sections.tree.complete === false
      && validObjectId('a'.repeat(40))
      && validObjectId('a'.repeat(64))
      && !validObjectId('a'.repeat(41));
  });
  await check('queue dependencies are recomputed from the issue body', () => {
    const issue = issueSnapshotItem({
      number: 7,
      title: 'dependency',
      body: '## Blocked by\n- #12',
      updatedAt: '2026-01-01T00:00:00Z',
      lastEditedAt: null,
      labels: ['loop-ready'],
    });
    const sections = Object.fromEntries(
      SNAPSHOT_SECTIONS.map((name) => [name, completeSection([])]),
    );
    sections.queue = completeSection([{
      ...issue,
      blockedBy: [],
      dependencies: [],
      provenance: {
        labeledBy: 'maintainer',
        labeledAt: '2026-01-01T00:00:01Z',
      },
    }]);
    const snapshot = createSnapshot({
      scannedAt: '2026-01-01T00:00:02.000Z',
      sections,
    });
    return snapshot.sections.queue.complete === false
      && stableJson(blockedByIssueNumbers(issue.body)) === stableJson([12]);
  });
  await check('blocker resolution requires exact typed dependency evidence', () => {
    const issue = issueSnapshotItem({
      number: 7,
      title: 'dependency',
      body: '## Blocked by\n- #12\n- #34',
      updatedAt: '2026-01-01T00:00:00Z',
      lastEditedAt: null,
      labels: ['loop-ready'],
    });
    const sections = Object.fromEntries(
      SNAPSHOT_SECTIONS.map((name) => [name, completeSection([])]),
    );
    sections.queue = completeSection([{
      ...issue,
      blockedBy: [12, 34],
      dependencies: [
        { number: 12, state: 'CLOSED' },
        { number: 34, state: 'CLOSED' },
      ],
      provenance: {
        labeledBy: 'maintainer',
        labeledAt: '2026-01-01T00:00:01Z',
      },
    }]);
    const snapshot = createSnapshot({
      scannedAt: '2026-01-01T00:00:02.000Z',
      sections,
    });
    const resolution = blockerResolutionDecision(snapshot, 7);
    return resolution.ok === true
      && !Object.hasOwn(SNAPSHOT_ABSENCE_REQUIREMENTS, 'blockerResolution');
  });
  await check('missing dependency evidence cannot mean closed', () => {
    const issue = issueSnapshotItem({
      number: 7,
      title: 'dependency',
      body: '## Blocked by\n- #12',
      updatedAt: '2026-01-01T00:00:00Z',
      lastEditedAt: null,
      labels: ['loop-ready'],
    });
    const sections = Object.fromEntries(
      SNAPSHOT_SECTIONS.map((name) => [name, completeSection([])]),
    );
    sections.openIssues = completeSection([]);
    sections.queue = completeSection([{
      ...issue,
      blockedBy: [12],
      dependencies: [],
      provenance: {
        labeledBy: 'maintainer',
        labeledAt: '2026-01-01T00:00:01Z',
      },
    }]);
    const snapshot = createSnapshot({
      scannedAt: '2026-01-01T00:00:02.000Z',
      sections,
    });
    return snapshot.sections.queue.complete === false
      && blockerResolutionDecision(snapshot, 7).ok === false;
  });
  await check('an observed open dependency blocks resolution', () => {
    const issue = issueSnapshotItem({
      number: 7,
      title: 'dependency',
      body: '## Blocked by\n- #12',
      updatedAt: '2026-01-01T00:00:00Z',
      lastEditedAt: null,
      labels: ['loop-ready'],
    });
    const sections = Object.fromEntries(
      SNAPSHOT_SECTIONS.map((name) => [name, completeSection([])]),
    );
    sections.openIssues = completeSection([]);
    sections.queue = completeSection([{
      ...issue,
      blockedBy: [12],
      dependencies: [{ number: 12, state: 'OPEN' }],
      provenance: {
        labeledBy: 'maintainer',
        labeledAt: '2026-01-01T00:00:01Z',
      },
    }]);
    const snapshot = createSnapshot({
      scannedAt: '2026-01-01T00:00:02.000Z',
      sections,
    });
    const resolution = blockerResolutionDecision(snapshot, 7);
    return resolution.ok === false
      && resolution.reasonCodes.includes('SNAPSHOT_DEPENDENCY_OPEN')
      && stableJson(resolution.openDependencies) === stableJson([12]);
  });
  await check('loop ownership is recomputed from the canonical claim', () => {
    const sections = Object.fromEntries(
      SNAPSHOT_SECTIONS.map((name) => [name, completeSection([])]),
    );
    sections.openPrs = completeSection([{
      number: 8,
      title: 'forged',
      body: 'no claim',
      isDraft: false,
      reviewDecision: null,
      headRefName: 'feature/no-claim',
      headRefOid: 'a'.repeat(40),
      baseRefName: 'main',
      mergeStateStatus: null,
      mergeable: null,
      mergedAt: null,
      updatedAt: '2026-01-01T00:00:00Z',
      author: 'actor',
      headRepository: 'owner/repo',
      statusCheckState: null,
      statusCheckRollup: [],
      issue: 7,
      orphanCandidate: false,
      ownership: 'loop',
    }]);
    const snapshot = createSnapshot({
      scannedAt: '2026-01-01T00:00:01.000Z',
      sections,
    });
    return snapshot.sections.openPrs.complete === false;
  });
  await check('fork PRs cannot carry loop ownership', () => {
    const sections = Object.fromEntries(
      SNAPSHOT_SECTIONS.map((name) => [name, completeSection([])]),
    );
    sections.repo = completeSection([{
      owner: 'owner',
      name: 'repo',
      nameWithOwner: 'owner/repo',
      defaultBranch: 'main',
    }]);
    sections.openPrs = completeSection([pullRequestItem({
      headRepository: 'fork/repo',
    })]);
    const snapshot = createSnapshot({
      scannedAt: '2026-01-01T00:00:01.000Z',
      sections,
    });
    return snapshot.sections.openPrs.complete === false
      && snapshot.sections.openPrs.error?.code === 'SNAPSHOT_SECTION_INVALID';
  });
  await check('fork PRs remain valid human-owned snapshot entries', () => {
    const sections = Object.fromEntries(
      SNAPSHOT_SECTIONS.map((name) => [name, completeSection([])]),
    );
    sections.repo = completeSection([{
      owner: 'owner',
      name: 'repo',
      nameWithOwner: 'owner/repo',
      defaultBranch: 'main',
    }]);
    sections.openPrs = completeSection([pullRequestItem({
      headRepository: 'fork/repo',
      issue: null,
      orphanCandidate: false,
      ownership: 'human',
    })]);
    const snapshot = createSnapshot({
      scannedAt: '2026-01-01T00:00:01.000Z',
      sections,
    });
    return snapshot.sections.openPrs.complete === true
      && verifySnapshot(snapshot);
  });
  await check('malformed snapshot envelopes fail closed without throwing', () => {
    const malformed = {
      kind: 'autoloop-repository-snapshot',
      version: SNAPSHOT_VERSION,
      scannedAt: '2026-01-01T00:00:00.000Z',
      generation: '0'.repeat(64),
      sections: null,
      invalidation: { reasonCodes: [], sections: [] },
      fingerprint: '0'.repeat(64),
    };
    const absence = absenceDecision(malformed, ['queue'], () => false);
    return verifySnapshot(malformed) === false
      && absence.ok === false
      && absence.reasonCodes.includes('SNAPSHOT_ABSENCE_INPUT_INVALID');
  });
  await check('invalid snapshot time cannot prove absence', () => {
    const snapshot = createSnapshot({
      scannedAt: 'today',
      sections: Object.fromEntries(
        SNAPSHOT_SECTIONS.map((name) => [name, completeSection([])]),
      ),
    });
    return absenceDecision(snapshot, ['queue'], () => false).ok === false
      && snapshot.sections.queue.error?.code === 'SNAPSHOT_TIMESTAMP_INVALID';
  });
  await check('complete empty section proves absence', () => {
    const snapshot = createSnapshot({
      scannedAt: '2026-01-01T00:00:00.000Z',
      sections: Object.fromEntries(SNAPSHOT_SECTIONS.map((name) => [name, completeSection([])])),
    });
    return absenceDecision(snapshot, ['queue', 'openIssues'], () => false).ok === true;
  });
  await check('matching evidence rejects absence', () => {
    const sections = Object.fromEntries(SNAPSHOT_SECTIONS.map((name) => [name, completeSection([])]));
    sections.queue = completeSection([{
      ...issueSnapshotItem({
        number: 9,
        title: 'queued',
        body: 'body',
        updatedAt: '2026-01-01T00:00:00Z',
        lastEditedAt: null,
        labels: ['loop-ready'],
      }),
      blockedBy: [],
      dependencies: [],
      provenance: {
        labeledBy: 'maintainer',
        labeledAt: '2026-01-01T00:00:00Z',
      },
    }]);
    const snapshot = createSnapshot({
      scannedAt: '2026-01-01T00:00:00.000Z',
      sections,
    });
    const result = absenceDecision(snapshot, ['queue'], (item) => item.number === 9);
    return !result.ok && result.reasonCodes.includes('SNAPSHOT_ITEM_PRESENT');
  });
  await check('pre-PR lifecycle marker is discoverable before queue selection', () => {
    const sections = Object.fromEntries(
      SNAPSHOT_SECTIONS.map((name) => [name, completeSection([])]),
    );
    sections.lifecycleMarkers = completeSection([lifecycleMarkerItem()]);
    const snapshot = createSnapshot({
      scannedAt: '2026-01-01T00:00:01.000Z',
      sections,
    });
    const selection = repositoryAbsenceDecision(
      snapshot,
      'selection',
      (_item, name) => name === 'lifecycleMarkers',
    );
    return snapshot.sections.lifecycleMarkers?.complete === true
      && snapshot.sections.openPrs.items.length === 0
      && selection.ok === false
      && selection.reasonCodes.includes('SNAPSHOT_ITEM_PRESENT');
  });
  await check('closed absence purposes require their complete sections', () => {
    return Object.entries(SNAPSHOT_ABSENCE_REQUIREMENTS).every(([purpose, required]) => {
      const sections = Object.fromEntries(
        SNAPSHOT_SECTIONS.map((name) => [name, completeSection([])]),
      );
      sections[required[0]] = incompleteSection('PAGE_FETCH_FAILED', 'offline');
      const snapshot = createSnapshot({
        scannedAt: '2026-01-01T00:00:00.000Z',
        sections,
      });
      return repositoryAbsenceDecision(snapshot, purpose, () => false).ok === false;
    });
  });
  await check('actionability requires complete issue and blocking-label evidence', () => {
    const sections = Object.fromEntries(
      SNAPSHOT_SECTIONS.map((name) => [name, completeSection([])]),
    );
    sections.blockedIssues = incompleteSection('PAGE_FETCH_FAILED', 'offline');
    sections.openIssues = incompleteSection('PAGE_FETCH_FAILED', 'offline');
    const snapshot = createSnapshot({
      scannedAt: '2026-01-01T00:00:00.000Z',
      sections,
    });
    const actionability = repositoryAbsenceDecision(
      snapshot,
      'actionability',
      () => false,
    );
    return actionability.ok === false
      && stableJson(actionability.incompleteSections)
        === stableJson(['blockedIssues', 'openIssues']);
  });

  const failures = checks.filter(([, passed]) => !passed);
  for (const [name] of failures) console.error(`FAIL: ${name}`);
  console.log(
    failures.length
      ? `self-test FAILED (${failures.length}/${checks.length})`
      : `self-test OK (${checks.length} checks)`,
  );
  return failures.length === 0;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(`snapshot-contract: ${parsed.error}`);
    return 2;
  }
  if (parsed.mode === 'self-test') return await selfTest() ? 0 : 1;
  try {
    const snapshot = readSnapshotInput();
    const result = parsed.mode === 'invalidate'
      ? invalidateSnapshot(snapshot, parsed.reasonCode)
      : {
        snapshot,
        evidence: createQueueEvidence({
          snapshot,
          purpose: parsed.purpose,
          runInstanceFingerprint: parsed.runInstanceFingerprint,
          configFingerprint: parsed.configFingerprint,
          configuredBaseBranch: parsed.configuredBaseBranch,
        }),
      };
    writeStdoutSync(`${JSON.stringify(result, null, 1)}\n`);
    return 0;
  } catch (error) {
    console.error(`snapshot-contract: ${error.message}`);
    return 1;
  }
}

const isMain = process.argv[1]
  ? pathToFileURL(process.argv[1]).href === import.meta.url
  : false;
if (isMain) process.exit(await main());
