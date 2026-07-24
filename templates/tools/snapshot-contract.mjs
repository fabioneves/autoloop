#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_SECTIONS = Object.freeze([
  'repo',
  'tree',
  'openPrs',
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
    'queue',
  ]),
  blockerResolution: Object.freeze(['openIssues']),
  actionability: Object.freeze([
    'authorVerification',
    'openPrs',
    'unresolvedReviewThreads',
  ]),
  queueExhaustion: Object.freeze([
    'authorVerification',
    'blockedIssues',
    'mergedPrs',
    'openIssues',
    'openPrs',
    'queue',
  ]),
  relaunch: Object.freeze([
    'authorVerification',
    'blockedIssues',
    'mergedPrs',
    'openIssues',
    'openPrs',
    'queue',
  ]),
  stop: Object.freeze([
    'authorVerification',
    'blockedIssues',
    'mergedPrs',
    'openIssues',
    'openPrs',
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
const ROLE_PERMISSIONS = new Set(['admin', 'none', 'read', 'write']);
const REVIEW_STATES = new Set([
  'APPROVED',
  'CHANGES_REQUESTED',
  'COMMENTED',
  'DISMISSED',
  'PENDING',
]);
const INVALIDATED_SECTIONS = {
  GIT_MUTATION: ['tree'],
  ISSUE_MUTATION: ['authorVerification', 'blockedIssues', 'openIssues', 'queue'],
  PR_MUTATION: [
    'authorVerification',
    'blockedIssues',
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

function hasExactKeys(value, keys) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
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
    && Array.isArray(section.items)
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
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function nullableDateTime(value) {
  return value === null || validDateTime(value);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validIssueItem(item) {
  return isRecord(item)
    && positiveInteger(item.number)
    && typeof item.title === 'string'
    && typeof item.body === 'string'
    && typeof item.bodySha256 === 'string'
    && /^[0-9a-f]{64}$/.test(item.bodySha256)
    && validDateTime(item.updatedAt)
    && nullableDateTime(item.lastEditedAt)
    && Array.isArray(item.labels)
    && item.labels.every(nonEmptyString)
    && new Set(item.labels).size === item.labels.length;
}

function validCheckContext(item) {
  return isRecord(item)
    && ['check-run', 'status-context'].includes(item.kind)
    && nonEmptyString(item.name)
    && nonEmptyString(item.status)
    && nullableString(item.conclusion)
    && nullableString(item.detailsUrl);
}

function validPullRequestItem(item) {
  const loopOwned = item?.ownership === 'loop';
  return isRecord(item)
    && positiveInteger(item.number)
    && typeof item.title === 'string'
    && typeof item.body === 'string'
    && typeof item.isDraft === 'boolean'
    && nullableString(item.reviewDecision)
    && nonEmptyString(item.headRefName)
    && typeof item.headRefOid === 'string'
    && /^[0-9a-f]{40,64}$/.test(item.headRefOid)
    && nonEmptyString(item.baseRefName)
    && nullableString(item.mergeStateStatus)
    && nullableString(item.mergeable)
    && nullableDateTime(item.mergedAt)
    && validDateTime(item.updatedAt)
    && nullableString(item.author)
    && nullableString(item.headRepository)
    && nullableString(item.statusCheckState)
    && Array.isArray(item.statusCheckRollup)
    && item.statusCheckRollup.every(validCheckContext)
    && (item.issue === null || positiveInteger(item.issue))
    && typeof item.orphanCandidate === 'boolean'
    && ['human', 'loop'].includes(item.ownership)
    && loopOwned === positiveInteger(item.issue)
    && item.orphanCandidate === (loopOwned && item.isDraft);
}

function validProvenance(value) {
  return isRecord(value)
    && nonEmptyString(value.labeledBy)
    && validDateTime(value.labeledAt);
}

function validQueueItem(item, complete) {
  return validIssueItem(item)
    && Array.isArray(item.blockedBy)
    && item.blockedBy.every(positiveInteger)
    && (
      validProvenance(item.provenance)
      || (!complete && item.provenance === null)
    );
}

function validEvidenceItem(item, requireAuthor = false) {
  if (
    !isRecord(item)
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
    return positiveInteger(item.issueNumber)
      && (item.state === null || item.state === undefined);
  }
  return positiveInteger(item.prNumber)
    && nonEmptyString(item.id)
    && (
      item.kind === 'review'
        ? REVIEW_STATES.has(item.state)
        : item.state === null || item.state === undefined
    );
}

function validReviewThreadItem(item) {
  return isRecord(item)
    && nonEmptyString(item.id)
    && positiveInteger(item.prNumber)
    && nonEmptyString(item.path)
    && (item.line === null || positiveInteger(item.line))
    && (item.originalLine === null || positiveInteger(item.originalLine))
    && typeof item.isOutdated === 'boolean'
    && Array.isArray(item.comments)
    && item.comments.every((comment) =>
      comment?.kind === 'review-thread-comment'
      && validEvidenceItem(comment));
}

function validAuthorVerificationItem(item, complete) {
  return isRecord(item)
    && nonEmptyString(item.login)
    && nullableString(item.roleName)
    && (
      ROLE_PERMISSIONS.has(item.permission)
      || (!complete && item.permission === null)
    )
    && Array.isArray(item.evidence)
    && item.evidence.length > 0
    && item.evidence.every((evidence) =>
      validEvidenceItem(evidence, true) && evidence.author === item.login);
}

const SECTION_ITEM_VALIDATORS = Object.freeze({
  repo: (item) => isRecord(item)
    && nonEmptyString(item.owner)
    && nonEmptyString(item.name)
    && item.nameWithOwner === `${item.owner}/${item.name}`
    && nonEmptyString(item.defaultBranch),
  tree: (item) => isRecord(item)
    && Array.isArray(item.dirtyEntries)
    && item.dirtyEntries.every((entry) => typeof entry === 'string')
    && item.dirtyPaths === item.dirtyEntries.length
    && nonEmptyString(item.branch)
    && typeof item.headOid === 'string'
    && /^[0-9a-f]{40,64}$/.test(item.headOid),
  openPrs: validPullRequestItem,
  queue: validQueueItem,
  blockedIssues: validIssueItem,
  openIssues: validIssueItem,
  mergedPrs: validPullRequestItem,
  unresolvedReviewThreads: validReviewThreadItem,
  authorVerification: validAuthorVerificationItem,
});

function validSnapshotSection(name, section) {
  if (!validSection(section)) return false;
  if (
    section.complete
    && ['repo', 'tree'].includes(name)
    && section.items.length !== 1
  ) {
    return false;
  }
  return section.items.every((item) =>
    SECTION_ITEM_VALIDATORS[name](item, section.complete));
}

export function completeSection(items = []) {
  if (!Array.isArray(items)) {
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
    items: Array.isArray(items) ? items : [],
    complete: false,
    error: errorRecord(code, message),
  };
}

export function combineSections(sections) {
  if (!Array.isArray(sections) || sections.some((section) => !validSection(section))) {
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
      || !Array.isArray(response.items)
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
    !Array.isArray(values)
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
    bodySha256: createHash('sha256').update(body).digest('hex'),
    updatedAt: typeof issue.updatedAt === 'string' ? issue.updatedAt : null,
    lastEditedAt: typeof issue.lastEditedAt === 'string' ? issue.lastEditedAt : null,
    labels: [...new Set(labels)].sort(),
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
  const normalizedSections = Object.fromEntries(
    SNAPSHOT_SECTIONS.map((name) => [
      name,
      timestampValid && validSnapshotSection(name, sections?.[name])
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
    if (
      !hasExactKeys(snapshot, SNAPSHOT_KEYS)
      || snapshot.kind !== 'autoloop-repository-snapshot'
      || snapshot.version !== SNAPSHOT_VERSION
      || !validTimestamp(snapshot.scannedAt)
      || !/^[0-9a-f]{64}$/.test(snapshot.generation)
      || !/^[0-9a-f]{64}$/.test(snapshot.fingerprint)
      || !hasExactKeys(snapshot.sections, SNAPSHOT_SECTIONS)
      || !SNAPSHOT_SECTIONS.every((name) =>
        validSnapshotSection(name, snapshot.sections[name]))
      || snapshot.generation !== snapshotGeneration(snapshot.scannedAt, snapshot.sections)
      || !hasExactKeys(snapshot.invalidation, INVALIDATION_KEYS)
      || !Array.isArray(snapshot.invalidation.reasonCodes)
      || !Array.isArray(snapshot.invalidation.sections)
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
    || !Array.isArray(sectionNames)
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

async function selfTest() {
  const checks = [];
  const check = async (name, test) => {
    try {
      checks.push([name, await test()]);
    } catch {
      checks.push([name, false]);
    }
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
      && invalidated.sections.tree.complete === true
      && invalidated.invalidation.reasonCodes.includes('ISSUE_MUTATION')
      && invalidated.generation === snapshot.generation
      && invalidated.fingerprint !== snapshot.fingerprint
      && verifySnapshot(invalidated);
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

  const failures = checks.filter(([, passed]) => !passed);
  for (const [name] of failures) console.error(`FAIL: ${name}`);
  console.log(
    failures.length
      ? `self-test FAILED (${failures.length}/${checks.length})`
      : `self-test OK (${checks.length} checks)`,
  );
  return failures.length === 0;
}

const isMain = process.argv[1]
  ? pathToFileURL(process.argv[1]).href === import.meta.url
  : false;
if (isMain) process.exit(await selfTest() ? 0 : 1);
