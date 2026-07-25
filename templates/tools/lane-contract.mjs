#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const SHARED_GUARDRAIL_ROOTS = ['tools', '.claude', '.codex', '.opencode', '.agents', '.githooks'];

export const DEPLOYMENT_GUARDRAIL_GLOBS = [
  'Dockerfile*',
  '**/Dockerfile*',
  'docker-compose*',
  '**/docker-compose*',
];

export const HUMAN_AUTHORIZATION_GLOBS = [
  '.env*',
  '**/.env*',
  '*credential*',
  '**/*credential*',
  '*private-key*',
  '**/*private-key*',
  '*private_key*',
  '**/*private_key*',
  '*.key',
  '**/*.key',
  '*.pem',
  '**/*.pem',
  '*.p12',
  '**/*.p12',
  '*.pfx',
  '**/*.pfx',
  'credentials/**',
  '**/credentials/**',
  'keys/**',
  '**/keys/**',
  'secrets/**',
  '**/secrets/**',
  '.github/workflows/**',
  '.autoloop/ci-policy.json',
  '.autoloop/measurement-budget-policy.json',
  '.autoloop/measurement-evidence-v1.json',
  ...DEPLOYMENT_GUARDRAIL_GLOBS,
  ...SHARED_GUARDRAIL_ROOTS.map((root) => `${root}/**`),
  'AGENTS.override.md',
  'AGENTS.md',
  'CLAUDE.md',
  '**/AGENTS.override.md',
  '**/AGENTS.md',
  '**/CLAUDE.md',
  'docs/agentic/STATE.md',
];

export const PATH_POLICY_FIXTURES = [
  { path: '.autoloop/ci-policy.json', humanAuthorization: true, mergeProtected: true },
  {
    path: '.autoloop/measurement-budget-policy.json',
    humanAuthorization: true,
    mergeProtected: true,
  },
  {
    path: '.autoloop/measurement-evidence-v1.json',
    humanAuthorization: true,
    mergeProtected: true,
  },
  { path: 'tools/agentic/gate.mjs', humanAuthorization: true, mergeProtected: true },
  { path: '.claude/settings.json', humanAuthorization: true, mergeProtected: true },
  { path: '.codex/hooks.json', humanAuthorization: true, mergeProtected: true },
  { path: '.opencode/plugins/autoloop.js', humanAuthorization: true, mergeProtected: true },
  { path: '.agents/plugins/marketplace.json', humanAuthorization: true, mergeProtected: true },
  { path: '.githooks/pre-push', humanAuthorization: true, mergeProtected: true },
  { path: 'config/credentials.yml', humanAuthorization: true, mergeProtected: true },
  { path: 'certs/private-key.pem', humanAuthorization: true, mergeProtected: true },
  { path: 'docker-compose.yaml', humanAuthorization: true, mergeProtected: true },
  { path: 'deploy/docker-compose.prod.yml', humanAuthorization: true, mergeProtected: true },
  { path: 'containers/Dockerfile.prod', humanAuthorization: true, mergeProtected: true },
  { path: '.github/dependabot.yml', humanAuthorization: false, mergeProtected: true },
  { path: 'package.json', humanAuthorization: false, mergeProtected: true },
  { path: 'docs/agentic/ARCH.md', humanAuthorization: false, mergeProtected: false },
  { path: 'docs/guide.md', humanAuthorization: false, mergeProtected: false },
];

export function globToRe(glob) {
  const source = String(glob)
    .split(/(\*\*|\*)/)
    .map((part) => {
      if (part === '**') return '.*';
      if (part === '*') return '[^/]*';
      return part.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${source}$`, 'i');
}

function normalizedGlobs(globs) {
  return [...new Set((globs ?? []).filter((glob) => typeof glob === 'string' && glob.length > 0))].sort();
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function matchHumanAuthorization(files, globs = HUMAN_AUTHORIZATION_GLOBS) {
  const patterns = normalizedGlobs(globs).map((glob) => ({ glob, re: globToRe(glob) }));
  const hits = [];
  for (const file of files ?? []) {
    if (typeof file !== 'string' || file.length === 0) {
      hits.push({ file, glob: '<opaque-path>' });
      continue;
    }
    const matched = patterns.find(({ re }) => re.test(file));
    if (matched) hits.push({ file, glob: matched.glob });
  }
  return hits;
}

const DEPLOYMENT_GUARDRAIL_RES = DEPLOYMENT_GUARDRAIL_GLOBS.map(globToRe);

const MERGE_PROTECTED_PATH_FAMILIES = [
  {
    name: 'CI requirements policy',
    matches: (path) => path === '.autoloop/ci-policy.json',
  },
  {
    name: 'measurement budget trust root',
    matches: (path) => [
      '.autoloop/measurement-budget-policy.json',
      '.autoloop/measurement-evidence-v1.json',
    ].includes(path),
  },
  { name: 'cryptographic credential paths', matches: (path) => /(^|\/)[^/]*crypt[^/]*(\/|$)/i.test(path) },
  { name: 'secret/credential path segments', matches: (path) => /(^|\/)[^/]*(secret|credential|token)[^/]*(\/|$)/i.test(path) },
  {
    name: 'key material',
    matches: (path) =>
      /(^|\/)(?:keys?|certs?)(\/|$)/i.test(path)
      || /(^|\/)[^/]*(?:private[-_]?key|keypair)[^/]*(\/|$)/i.test(path)
      || /\.(?:jks|key|keystore|p12|pem|pfx)$/i.test(path),
  },
  { name: 'env files', matches: (path) => /(^|\/)\.env[^/]*$/i.test(path) },
  ...SHARED_GUARDRAIL_ROOTS.map((root) => ({
    name: root,
    matches: (path) => new RegExp(`^${root.replace('.', '\\.')}\\/`, 'i').test(path),
  })),
  { name: '.github', matches: (path) => /^\.github\//i.test(path) },
  { name: 'root dotfile/dot-directory', matches: (path) => /^\./.test(path) },
  { name: 'docs/agentic', matches: (path) => /^docs\/agentic\//i.test(path) && !/^docs\/agentic\/ARCH\.md$/i.test(path) },
  { name: 'CLAUDE.md', matches: (path) => /(^|\/)CLAUDE\.md$/i.test(path) },
  { name: 'AGENTS guidance', matches: (path) => /(^|\/)AGENTS(?:\.override)?\.md$/i.test(path) },
  {
    name: 'container build/compose',
    matches: (path) => DEPLOYMENT_GUARDRAIL_RES.some((pattern) => pattern.test(path)),
  },
  { name: 'package.json', matches: (path) => path.split('/').some((part) => part.toLowerCase() === 'package.json') },
  { name: 'lockfile', matches: (path) => path.split('/').some((part) => /^(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|.+\.lock)$/i.test(part)) },
  { name: 'tsconfig', matches: (path) => /(^|\/)tsconfig[^/]*$/i.test(path) },
  { name: 'build/test/lint config', matches: (path) => /(^|\/)(vite|vitest|eslint|postcss|tailwind|jest|webpack|rollup)\.config(\.[^/]+)?$/i.test(path) },
  { name: 'data files', matches: (path) => /^data\//i.test(path) },
];

export function matchMergeProtected(files, extraGlobs = []) {
  const extraFamilies = normalizedGlobs(extraGlobs).map((glob) => ({
    name: `extra-protected ${glob}`,
    matches: (path) => globToRe(glob).test(path),
  }));
  const hits = [];
  for (const file of files ?? []) {
    if (typeof file !== 'string' || file.length === 0) {
      hits.push({ file, family: 'opaque path' });
      continue;
    }
    const matched = [...MERGE_PROTECTED_PATH_FAMILIES, ...extraFamilies].find(({ matches }) => matches(file));
    if (matched) hits.push({ file, family: matched.name });
  }
  return hits;
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

const HEX_40 = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const ZERO_40 = '0'.repeat(40);
const ZERO_64 = '0'.repeat(64);
const PROOF_KEYS = [
  'configuredBase',
  'decisionEvidence',
  'fingerprint',
  'inputHash',
  'kind',
  'lane',
  'mode',
  'proofHash',
  'reasonCodes',
  'subject',
  'version',
];
const PLANNED_EVIDENCE_KEYS = [
  'estimatedChangedLines',
  'files',
  'humanAuthorizationGlobs',
  'kind',
  'normalizationReasonCodes',
  'persistedData',
  'sourceComplete',
];
const FINAL_EVIDENCE_KEYS = [
  'changedFiles',
  'files',
  'humanAuthorizationGlobs',
  'kind',
  'normalizationReasonCodes',
  'persistedData',
  'sourceComplete',
];
const PLANNED_FILE_KEYS = ['contentHash', 'contentRead', 'path'];
const FINAL_FILE_KEYS = [
  'additions',
  'contentHash',
  'contentRead',
  'deletions',
  'path',
  'previousContentRead',
  'previousPath',
  'status',
];
const SOURCE_COMPLETE_REASONS = new Set([
  'FINAL_FILES_EMPTY',
  'FINAL_STATUS_UNSAFE',
  'PLANNED_FILES_EMPTY',
]);

function hasExactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
  );
}

function canonicalReasons(reasons) {
  return [...new Set(reasons)].sort();
}

function sameValue(left, right) {
  return stableJson(left) === stableJson(right);
}

function normalizedBase(base, reasonCodes) {
  const exact = hasExactKeys(base, ['oid', 'ref']);
  const rawRef = exact && typeof base.ref === 'string' ? base.ref : '';
  const rawOid = exact && typeof base.oid === 'string' ? base.oid : '';
  const validRef = rawRef.length > 0 && !/[\x00-\x1f\x7f]/.test(rawRef);
  const validOid = /^[0-9a-f]{40}$/.test(rawOid) && !/^0{40}$/.test(rawOid);
  if (!exact) reasonCodes.push('BASE_SHAPE_OPAQUE');
  if (!validRef) reasonCodes.push('BASE_REF_UNAVAILABLE');
  if (!validOid) reasonCodes.push('BASE_OID_UNAVAILABLE');
  return {
    ref: validRef ? rawRef : '(unavailable)',
    oid: validOid ? rawOid : ZERO_40,
  };
}

function normalizedSubject(mode, subject, reasonCodes) {
  if (mode === 'final') {
    const valid =
      hasExactKeys(subject, ['headOid', 'kind']) &&
      subject.kind === 'head' &&
      HEX_40.test(subject.headOid) &&
      subject.headOid !== ZERO_40;
    if (!valid) reasonCodes.push('HEAD_SUBJECT_UNAVAILABLE');
    return { kind: 'head', headOid: valid ? subject.headOid : ZERO_40 };
  }
  const valid =
    hasExactKeys(subject, ['artifactVersion', 'fingerprint', 'kind']) &&
    subject.kind === 'plan' &&
    Number.isSafeInteger(subject.artifactVersion) &&
    subject.artifactVersion > 0 &&
    HEX_64.test(subject.fingerprint) &&
    subject.fingerprint !== ZERO_64;
  if (!valid) reasonCodes.push('PLAN_SUBJECT_UNAVAILABLE');
  return {
    kind: 'plan',
    artifactVersion: valid ? subject.artifactVersion : 1,
    fingerprint: valid ? subject.fingerprint : ZERO_64,
  };
}

function normalizedPath(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    value.includes('\ufffd')
  ) {
    return null;
  }
  if (value.startsWith('/') || value.includes('\\')) return null;
  const parts = value.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) return null;
  return value;
}

function plannedEvidence(raw, reasonCodes) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    reasonCodes.push('PLANNED_EVIDENCE_OPAQUE');
    return { files: [], estimatedChangedLines: null, persistedData: null };
  }
  if (raw.complete !== true) reasonCodes.push('PLANNED_FILES_INCOMPLETE');
  if (!Array.isArray(raw.files)) {
    reasonCodes.push('PLANNED_FILES_OPAQUE');
    return {
      files: [],
      estimatedChangedLines: Number.isInteger(raw.estimatedChangedLines) ? raw.estimatedChangedLines : null,
      persistedData: typeof raw.persistedData === 'boolean' ? raw.persistedData : null,
    };
  }
  const files = [];
  for (const entry of raw.files) {
    const path = normalizedPath(typeof entry === 'string' ? entry : entry?.path);
    if (!path) {
      reasonCodes.push('PLANNED_PATH_OPAQUE');
      continue;
    }
    const contentHash =
      typeof entry === 'object' && /^[0-9a-f]{64}$/i.test(entry?.contentHash ?? '')
        ? entry.contentHash.toLowerCase()
        : null;
    if (typeof entry === 'object' && entry?.contentHash != null && contentHash === null) {
      reasonCodes.push('PLANNED_CONTENT_HASH_OPAQUE');
    }
    files.push({
      path,
      contentRead: typeof entry === 'object' && entry?.contentRead === true,
      contentHash,
    });
  }
  files.sort((a, b) => compareText(a.path, b.path));
  if (!files.length) reasonCodes.push('PLANNED_FILES_EMPTY');
  if (new Set(files.map(({ path }) => path)).size !== files.length) reasonCodes.push('PLANNED_PATH_DUPLICATE');
  const estimatedChangedLines =
    Number.isInteger(raw.estimatedChangedLines) && raw.estimatedChangedLines >= 0
      ? raw.estimatedChangedLines
      : null;
  const persistedData = typeof raw.persistedData === 'boolean' ? raw.persistedData : null;
  return { files, estimatedChangedLines, persistedData };
}

function normalizedStatus(value) {
  if (typeof value !== 'string') return null;
  const match = /^([ACDMRTUXB])(\d{1,3})?$/.exec(value.toUpperCase());
  if (
    !match ||
    (match[2] && (!['R', 'C'].includes(match[1]) || Number(match[2]) > 100))
  ) {
    return null;
  }
  return { raw: value.toUpperCase(), code: match[1] };
}

function finalEvidence(raw, reasonCodes) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    reasonCodes.push('FINAL_EVIDENCE_OPAQUE');
    return { changedFiles: null, files: [], persistedData: null };
  }
  if (raw.complete !== true) reasonCodes.push('FINAL_DIFF_INCOMPLETE');
  if (!Array.isArray(raw.files)) {
    reasonCodes.push('FINAL_FILES_OPAQUE');
    return {
      changedFiles: Number.isInteger(raw.changedFiles) ? raw.changedFiles : null,
      files: [],
      persistedData: typeof raw.persistedData === 'boolean' ? raw.persistedData : null,
    };
  }
  const files = [];
  for (const entry of raw.files) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      reasonCodes.push('FINAL_ENTRY_OPAQUE');
      continue;
    }
    const status = normalizedStatus(entry.status);
    const path = normalizedPath(entry.path);
    const previousPath = entry.previousPath == null ? null : normalizedPath(entry.previousPath);
    const additions = Number.isInteger(entry.additions) && entry.additions >= 0 ? entry.additions : null;
    const deletions = Number.isInteger(entry.deletions) && entry.deletions >= 0 ? entry.deletions : null;
    const contentHash = /^[0-9a-f]{64}$/i.test(entry.contentHash ?? '') ? entry.contentHash.toLowerCase() : null;
    if (!status) reasonCodes.push('FINAL_STATUS_OPAQUE');
    if (!path) reasonCodes.push('FINAL_PATH_OPAQUE');
    if (additions === null || deletions === null) reasonCodes.push('FINAL_NUMSTAT_OPAQUE');
    if (entry.contentHash != null && contentHash === null) reasonCodes.push('FINAL_CONTENT_HASH_OPAQUE');
    if (status && ['U', 'X', 'B', 'T'].includes(status.code)) reasonCodes.push('FINAL_STATUS_UNSAFE');
    if (status && ['R', 'C'].includes(status.code) && !previousPath) reasonCodes.push('FINAL_RENAME_SOURCE_OPAQUE');
    if (status && !['R', 'C'].includes(status.code) && entry.previousPath != null) {
      reasonCodes.push('FINAL_RENAME_STATUS_INCONSISTENT');
    }
    if (status && path) {
      files.push({
        status: status.raw,
        previousPath,
        path,
        additions,
        deletions,
        contentRead: entry.contentRead === true,
        previousContentRead: entry.previousContentRead === true,
        contentHash,
      });
    }
  }
  files.sort((a, b) => compareText(
    `${a.previousPath ?? ''}\0${a.path}\0${a.status}`,
    `${b.previousPath ?? ''}\0${b.path}\0${b.status}`,
  ));
  if (!files.length) reasonCodes.push('FINAL_FILES_EMPTY');
  if (new Set(files.map(({ path }) => path)).size !== files.length) reasonCodes.push('FINAL_PATH_DUPLICATE');
  const changedFiles = Number.isInteger(raw.changedFiles) && raw.changedFiles >= 0 ? raw.changedFiles : null;
  if (changedFiles === null) reasonCodes.push('FINAL_CHANGED_FILES_OPAQUE');
  else if (changedFiles !== raw.files.length || changedFiles !== files.length) reasonCodes.push('FINAL_CHANGED_FILES_INCONSISTENT');
  return {
    changedFiles,
    files,
    persistedData: typeof raw.persistedData === 'boolean' ? raw.persistedData : null,
  };
}

function evidencePaths(mode, evidence) {
  if (mode === 'planned') return evidence.files.map(({ path }) => path);
  return evidence.files.flatMap(({ previousPath, path }) => previousPath ? [previousPath, path] : [path]);
}

function docsContentRead(mode, evidence) {
  if (mode === 'planned') return evidence.files.every(({ contentRead }) => contentRead);
  return evidence.files.every(({ status, contentRead, previousContentRead }) =>
    contentRead && (!['R', 'C'].includes(status[0]) || previousContentRead));
}

function isDocsPath(path) {
  return /^docs\//i.test(path) || /\.md$/i.test(path);
}

function sourceCompleteFromReasons(reasons) {
  return reasons.every((reason) => SOURCE_COMPLETE_REASONS.has(reason));
}

function canonicalDecisionEvidence(mode, evidence, reasons, globs) {
  const normalizationReasonCodes = canonicalReasons([
    ...reasons,
    ...intrinsicEvidenceReasons(mode, evidence),
  ]);
  const shared = {
    kind: mode,
    sourceComplete: sourceCompleteFromReasons(normalizationReasonCodes),
    normalizationReasonCodes,
    humanAuthorizationGlobs: globs,
    files: evidence.files,
    persistedData: evidence.persistedData,
  };
  return mode === 'planned'
    ? { ...shared, estimatedChangedLines: evidence.estimatedChangedLines }
    : { ...shared, changedFiles: evidence.changedFiles };
}

function intrinsicEvidenceReasons(mode, evidence) {
  const reasons = [];
  if (!evidence.files.length) {
    reasons.push(mode === 'planned' ? 'PLANNED_FILES_EMPTY' : 'FINAL_FILES_EMPTY');
  }
  if (new Set(evidence.files.map(({ path }) => path)).size !== evidence.files.length) {
    reasons.push(mode === 'planned' ? 'PLANNED_PATH_DUPLICATE' : 'FINAL_PATH_DUPLICATE');
  }
  if (mode === 'final') {
    if (evidence.changedFiles === null) reasons.push('FINAL_CHANGED_FILES_OPAQUE');
    else if (evidence.changedFiles !== evidence.files.length) {
      reasons.push('FINAL_CHANGED_FILES_INCONSISTENT');
    }
    for (const file of evidence.files) {
      const code = file.status[0];
      if (['U', 'X', 'B', 'T'].includes(code)) reasons.push('FINAL_STATUS_UNSAFE');
      if (['R', 'C'].includes(code) && file.previousPath === null) {
        reasons.push('FINAL_RENAME_SOURCE_OPAQUE');
      }
      if (!['R', 'C'].includes(code) && file.previousPath !== null) {
        reasons.push('FINAL_RENAME_STATUS_INCONSISTENT');
      }
      if (file.additions === null || file.deletions === null) {
        reasons.push('FINAL_NUMSTAT_OPAQUE');
      }
    }
  }
  return canonicalReasons(reasons);
}

function validPlannedFile(file) {
  return (
    hasExactKeys(file, PLANNED_FILE_KEYS) &&
    normalizedPath(file.path) === file.path &&
    typeof file.contentRead === 'boolean' &&
    (file.contentHash === null || HEX_64.test(file.contentHash))
  );
}

function validFinalFile(file) {
  const status = normalizedStatus(file?.status);
  return (
    hasExactKeys(file, FINAL_FILE_KEYS) &&
    status?.raw === file.status &&
    normalizedPath(file.path) === file.path &&
    (file.previousPath === null || normalizedPath(file.previousPath) === file.previousPath) &&
    (file.additions === null || (Number.isSafeInteger(file.additions) && file.additions >= 0)) &&
    (file.deletions === null || (Number.isSafeInteger(file.deletions) && file.deletions >= 0)) &&
    typeof file.contentRead === 'boolean' &&
    typeof file.previousContentRead === 'boolean' &&
    (file.contentHash === null || HEX_64.test(file.contentHash))
  );
}

function validDecisionEvidence(mode, evidence) {
  const expectedKeys = mode === 'planned' ? PLANNED_EVIDENCE_KEYS : FINAL_EVIDENCE_KEYS;
  if (
    !hasExactKeys(evidence, expectedKeys) ||
    evidence.kind !== mode ||
    typeof evidence.sourceComplete !== 'boolean' ||
    !Array.isArray(evidence.normalizationReasonCodes) ||
    evidence.normalizationReasonCodes.some(
      (reason) => typeof reason !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(reason),
    ) ||
    !sameValue(
      canonicalReasons(evidence.normalizationReasonCodes),
      evidence.normalizationReasonCodes,
    ) ||
    evidence.sourceComplete !== sourceCompleteFromReasons(evidence.normalizationReasonCodes) ||
    !Array.isArray(evidence.humanAuthorizationGlobs) ||
    evidence.humanAuthorizationGlobs.some(
      (glob) => typeof glob !== 'string' || glob.length === 0,
    ) ||
    !sameValue(normalizedGlobs(evidence.humanAuthorizationGlobs), evidence.humanAuthorizationGlobs) ||
    !HUMAN_AUTHORIZATION_GLOBS.every(
      (glob) => evidence.humanAuthorizationGlobs.includes(glob),
    ) ||
    !Array.isArray(evidence.files) ||
    !evidence.files.every(mode === 'planned' ? validPlannedFile : validFinalFile) ||
    ![null, true, false].includes(evidence.persistedData)
  ) {
    return false;
  }
  const sortedFiles = [...evidence.files].sort((left, right) =>
    compareText(
      mode === 'planned'
        ? left.path
        : `${left.previousPath ?? ''}\0${left.path}\0${left.status}`,
      mode === 'planned'
        ? right.path
        : `${right.previousPath ?? ''}\0${right.path}\0${right.status}`,
    ));
  if (!sameValue(sortedFiles, evidence.files)) return false;
  if (
    mode === 'planned' &&
    !(
      evidence.estimatedChangedLines === null ||
      (Number.isSafeInteger(evidence.estimatedChangedLines) &&
        evidence.estimatedChangedLines >= 0)
    )
  ) {
    return false;
  }
  if (
    mode === 'final' &&
    !(
      evidence.changedFiles === null ||
      (Number.isSafeInteger(evidence.changedFiles) && evidence.changedFiles >= 0)
    )
  ) {
    return false;
  }
  const intrinsic = intrinsicEvidenceReasons(mode, evidence);
  return intrinsic.every((reason) => evidence.normalizationReasonCodes.includes(reason));
}

function laneDecision(mode, evidence, structuralReasons, globs) {
  if (structuralReasons.length) return { lane: 'full', reasonCodes: structuralReasons };
  const paths = evidencePaths(mode, evidence);
  if (matchHumanAuthorization(paths, globs).length) {
    return { lane: 'full', reasonCodes: ['HUMAN_AUTHORIZATION_PATH'] };
  }
  if (paths.every(isDocsPath)) {
    return docsContentRead(mode, evidence)
      ? { lane: 'docs', reasonCodes: [] }
      : { lane: 'full', reasonCodes: ['DOCS_CONTENT_UNREAD'] };
  }
  const reasons = [];
  if (evidence.files.length > 2) reasons.push('SMALL_FILE_LIMIT_EXCEEDED');
  const changedLines =
    mode === 'planned'
      ? evidence.estimatedChangedLines
      : evidence.files.reduce((total, file) =>
        total === null || file.additions === null || file.deletions === null
          ? null
          : total + file.additions + file.deletions, 0);
  if (changedLines === null) reasons.push('SMALL_LINE_ESTIMATE_OPAQUE');
  else if (changedLines > 50) reasons.push('SMALL_LINE_LIMIT_EXCEEDED');
  if (evidence.persistedData !== false) reasons.push('SMALL_PERSISTED_DATA_UNVERIFIED');
  return reasons.length ? { lane: 'full', reasonCodes: reasons } : { lane: 'small', reasonCodes: [] };
}

function validSubject(mode, subject, allowUnavailable) {
  if (mode === 'final') {
    return (
      hasExactKeys(subject, ['headOid', 'kind']) &&
      subject.kind === 'head' &&
      HEX_40.test(subject.headOid) &&
      (allowUnavailable || subject.headOid !== ZERO_40)
    );
  }
  return (
    hasExactKeys(subject, ['artifactVersion', 'fingerprint', 'kind']) &&
    subject.kind === 'plan' &&
    Number.isSafeInteger(subject.artifactVersion) &&
    subject.artifactVersion > 0 &&
    HEX_64.test(subject.fingerprint) &&
    (allowUnavailable || subject.fingerprint !== ZERO_64)
  );
}

function proofContextReasons(proof) {
  const reasons = [];
  if (proof.configuredBase.ref === '(unavailable)') reasons.push('BASE_REF_UNAVAILABLE');
  if (proof.configuredBase.oid === ZERO_40) reasons.push('BASE_OID_UNAVAILABLE');
  if (proof.mode === 'planned' && proof.subject.fingerprint === ZERO_64) {
    reasons.push('PLAN_SUBJECT_UNAVAILABLE');
  }
  if (proof.mode === 'final' && proof.subject.headOid === ZERO_40) {
    reasons.push('HEAD_SUBJECT_UNAVAILABLE');
  }
  return reasons;
}

function proofHashFor(proof) {
  return sha256({
    kind: proof.kind,
    version: proof.version,
    mode: proof.mode,
    lane: proof.lane,
    configuredBase: proof.configuredBase,
    subject: proof.subject,
    inputHash: proof.inputHash,
    reasonCodes: proof.reasonCodes,
  });
}

function sealProof(proof) {
  const proofHash = proofHashFor(proof);
  return {
    ...proof,
    proofHash,
    fingerprint: sha256({ kind: 'autoloop-lane-fingerprint', proofHash }),
  };
}

export function verifyLaneProof(proof, expectations = {}) {
  if (
    !hasExactKeys(proof, PROOF_KEYS) ||
    proof.kind !== 'autoloop-lane-proof' ||
    proof.version !== 1 ||
    !['planned', 'final'].includes(proof.mode) ||
    !['docs', 'small', 'full'].includes(proof.lane) ||
    !hasExactKeys(proof.configuredBase, ['oid', 'ref']) ||
    typeof proof.configuredBase.ref !== 'string' ||
    proof.configuredBase.ref.length === 0 ||
    /[\x00-\x1f\x7f]/.test(proof.configuredBase.ref) ||
    !HEX_40.test(proof.configuredBase.oid) ||
    !validSubject(proof.mode, proof.subject, true) ||
    !validDecisionEvidence(proof.mode, proof.decisionEvidence) ||
    !HEX_64.test(proof.inputHash) ||
    !HEX_64.test(proof.proofHash) ||
    !HEX_64.test(proof.fingerprint) ||
    !Array.isArray(proof.reasonCodes) ||
    proof.reasonCodes.some(
      (reason) => typeof reason !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(reason),
    ) ||
    !sameValue(canonicalReasons(proof.reasonCodes), proof.reasonCodes)
  ) {
    return false;
  }
  const contextReasons = proofContextReasons(proof);
  if (
    !contextReasons.every((reason) =>
      proof.decisionEvidence.normalizationReasonCodes.includes(reason))
  ) {
    return false;
  }
  const decision = laneDecision(
    proof.mode,
    proof.decisionEvidence,
    proof.decisionEvidence.normalizationReasonCodes,
    proof.decisionEvidence.humanAuthorizationGlobs,
  );
  const reasonCodes = canonicalReasons(decision.reasonCodes);
  if (decision.lane !== proof.lane || !sameValue(reasonCodes, proof.reasonCodes)) {
    return false;
  }
  const inputHash = sha256({
    mode: proof.mode,
    configuredBase: proof.configuredBase,
    subject: proof.subject,
    decisionEvidence: proof.decisionEvidence,
  });
  if (
    inputHash !== proof.inputHash ||
    proofHashFor(proof) !== proof.proofHash ||
    sha256({ kind: 'autoloop-lane-fingerprint', proofHash: proof.proofHash }) !==
      proof.fingerprint
  ) {
    return false;
  }
  if (
    expectations === null ||
    typeof expectations !== 'object' ||
    Array.isArray(expectations) ||
    Object.keys(expectations).some(
      (key) => !['expectedBaseOid', 'expectedSubject'].includes(key),
    )
  ) {
    return false;
  }
  if (
    expectations.expectedBaseOid !== undefined &&
    (!HEX_40.test(expectations.expectedBaseOid) ||
      expectations.expectedBaseOid !== proof.configuredBase.oid)
  ) {
    return false;
  }
  if (
    expectations.expectedSubject !== undefined &&
    (!validSubject(proof.mode, expectations.expectedSubject, false) ||
      !sameValue(expectations.expectedSubject, proof.subject))
  ) {
    return false;
  }
  return true;
}

export function classifyLaneProof(input = {}, options = {}) {
  const structuralReasons = [];
  const candidate = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const settings = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  if (candidate !== input) structuralReasons.push('INPUT_OPAQUE');
  if (settings !== options) structuralReasons.push('OPTIONS_OPAQUE');
  const mode = candidate.mode === 'final' ? 'final' : 'planned';
  if (!['planned', 'final'].includes(candidate.mode)) structuralReasons.push('MODE_INVALID');
  const configuredBase = normalizedBase(candidate.configuredBase, structuralReasons);
  const subject = normalizedSubject(mode, candidate.subject, structuralReasons);
  const evidence =
    mode === 'final'
      ? finalEvidence(candidate.final, structuralReasons)
      : plannedEvidence(candidate.planned, structuralReasons);
  const extraGlobs = settings.extraHumanAuthorizationGlobs;
  if (
    extraGlobs != null &&
    (!Array.isArray(extraGlobs) || extraGlobs.some((glob) => typeof glob !== 'string' || glob.length === 0))
  ) {
    structuralReasons.push('HUMAN_AUTHORIZATION_POLICY_OPAQUE');
  }
  const globs = normalizedGlobs([
    ...HUMAN_AUTHORIZATION_GLOBS,
    ...(Array.isArray(extraGlobs) ? extraGlobs : []),
  ]);
  const decisionEvidence = canonicalDecisionEvidence(
    mode,
    evidence,
    structuralReasons,
    globs,
  );
  const decision = laneDecision(
    mode,
    decisionEvidence,
    decisionEvidence.normalizationReasonCodes,
    globs,
  );
  const reasonCodes = [...new Set(decision.reasonCodes)].sort();
  const inputHash = sha256({
    mode,
    configuredBase,
    subject,
    decisionEvidence,
  });
  return sealProof({
    kind: 'autoloop-lane-proof',
    version: 1,
    mode,
    lane: decision.lane,
    configuredBase,
    subject,
    decisionEvidence,
    inputHash,
    reasonCodes,
  });
}

function planned(files, extras = {}) {
  return {
    mode: 'planned',
    configuredBase: { ref: 'origin/main', oid: '1'.repeat(40) },
    subject: { kind: 'plan', artifactVersion: 3, fingerprint: '5'.repeat(64) },
    planned: { complete: true, files, estimatedChangedLines: 20, persistedData: false, ...extras },
  };
}

function final(files, extras = {}) {
  return {
    mode: 'final',
    configuredBase: { ref: 'origin/main', oid: '1'.repeat(40) },
    subject: { kind: 'head', headOid: '3'.repeat(40) },
    final: {
      complete: true,
      changedFiles: files.length,
      files,
      persistedData: false,
      ...extras,
    },
  };
}

function selfTest() {
  const docs = classifyLaneProof(planned([{ path: 'docs/guide.md', contentRead: true }]));
  const unreadDocs = classifyLaneProof(planned([{ path: 'docs/guide.md', contentRead: false }]));
  const small = classifyLaneProof(planned([{ path: 'src/one.mjs' }, { path: 'src/two.mjs' }]));
  const opaqueSmall = classifyLaneProof(planned([{ path: 'src/one.mjs' }], { estimatedChangedLines: null }));
  const finalDocs = classifyLaneProof(final([
    { status: 'M', path: 'docs/guide.md', additions: 2, deletions: 1, contentRead: true },
  ]));
  const safeRename = classifyLaneProof(final([
    {
      status: 'R100',
      previousPath: 'docs/old.md',
      path: 'docs/new.md',
      additions: 0,
      deletions: 0,
      contentRead: true,
      previousContentRead: true,
    },
  ]));
  const opaqueRename = classifyLaneProof(final([
    { status: 'R100', path: 'docs/new.md', additions: 0, deletions: 0, contentRead: true },
  ]));
  const binary = classifyLaneProof(final([
    { status: 'M', path: 'src/image.png', additions: '-', deletions: '-', contentRead: true },
  ]));
  const incompleteFinal = classifyLaneProof(final([
    { status: 'M', path: 'src/one.mjs', additions: 1, deletions: 1 },
  ], { complete: false }));
  const changedFilesMismatch = classifyLaneProof(final([
    { status: 'M', path: 'src/one.mjs', additions: 1, deletions: 1 },
  ], { changedFiles: 2 }));
  const unsafeStatus = classifyLaneProof(final([
    { status: 'U', path: 'src/one.mjs', additions: 1, deletions: 1 },
  ]));
  const escalatedRename = classifyLaneProof(final([
    {
      status: 'R100',
      previousPath: '.githooks/pre-push',
      path: 'docs/pre-push.md',
      additions: 1,
      deletions: 1,
      contentRead: true,
      previousContentRead: true,
    },
  ]));
  const escalated = classifyLaneProof(planned([{ path: '.opencode/plugins/autoloop.js', contentRead: true }]));
  const baseChanged = classifyLaneProof({
    ...planned([{ path: 'docs/guide.md', contentRead: true }]),
    configuredBase: { ref: 'origin/release', oid: '2'.repeat(40) },
  });
  const headChangedInput = final([
    { status: 'M', path: 'docs/guide.md', additions: 2, deletions: 1, contentRead: true },
  ]);
  headChangedInput.subject = { kind: 'head', headOid: '4'.repeat(40) };
  const headChanged = classifyLaneProof(headChangedInput);
  const opaqueInput = classifyLaneProof(null);
  const nullPlanned = classifyLaneProof({ ...planned([]), planned: null });
  const traversalPlanned = classifyLaneProof(planned([
    { path: '../.opencode/plugins/autoloop.js', contentRead: true },
  ]));
  const malformedPlanned = classifyLaneProof({
    ...planned([]),
    planned: { complete: true, files: { path: 'docs/guide.md' } },
  });
  const forgedLane = sealProof({ ...opaqueSmall, lane: 'docs', reasonCodes: [] });
  const checks = [
    ['planned docs', docs.mode === 'planned' && docs.lane === 'docs'],
    ['unread docs fail closed', unreadDocs.lane === 'full' && unreadDocs.reasonCodes.includes('DOCS_CONTENT_UNREAD')],
    ['planned small', small.lane === 'small'],
    ['opaque small fails closed', opaqueSmall.lane === 'full'],
    ['final docs', finalDocs.mode === 'final' && finalDocs.lane === 'docs'],
    ['complete rename', safeRename.lane === 'docs'],
    ['opaque rename fails closed', opaqueRename.lane === 'full'],
    ['binary numstat fails closed', binary.lane === 'full'],
    ['incomplete final diff fails closed', incompleteFinal.lane === 'full'],
    ['changed-file mismatch fails closed', changedFilesMismatch.lane === 'full'],
    ['unsafe diff status fails closed', unsafeStatus.lane === 'full'],
    ['rename source is classified', escalatedRename.lane === 'full'],
    ['escalation wins', escalated.lane === 'full'],
    ['base-bound fingerprint', docs.fingerprint !== baseChanged.fingerprint],
    ['head-bound fingerprint', finalDocs.fingerprint !== headChanged.fingerprint],
    ['deterministic fingerprint', docs.fingerprint === classifyLaneProof(planned([{ path: 'docs/guide.md', contentRead: true }])).fingerprint],
    [
      'file order does not change fingerprint',
      small.fingerprint === classifyLaneProof(planned([
        { path: 'src/two.mjs' },
        { path: 'src/one.mjs' },
      ])).fingerprint,
    ],
    ['hash fields', [docs.inputHash, docs.proofHash, docs.fingerprint].every((value) => /^[0-9a-f]{64}$/.test(value))],
    ['proof verifies', verifyLaneProof(docs)],
    ['tampered proof rejected', !verifyLaneProof({ ...docs, lane: 'full' })],
    ['canonical decision evidence included', docs.decisionEvidence?.kind === 'planned'],
    ['planned subject bound', docs.subject?.kind === 'plan' && docs.subject.artifactVersion === 3],
    ['final subject bound', finalDocs.subject?.kind === 'head' && finalDocs.subject.headOid === '3'.repeat(40)],
    ['forged lane rejected after rehash', !verifyLaneProof(forgedLane)],
    [
      'expected subject mismatch rejected',
      !verifyLaneProof(docs, {
        expectedSubject: { kind: 'plan', artifactVersion: 4, fingerprint: '5'.repeat(64) },
      }),
    ],
    ['expected base mismatch rejected', !verifyLaneProof(docs, { expectedBaseOid: '2'.repeat(40) })],
    ['null planned source incomplete', nullPlanned.decisionEvidence?.sourceComplete === false],
    ['malformed planned source incomplete', malformedPlanned.decisionEvidence?.sourceComplete === false],
    ['path traversal source incomplete', traversalPlanned.decisionEvidence?.sourceComplete === false],
    ['opaque input fails closed', opaqueInput.lane === 'full' && verifyLaneProof(opaqueInput)],
    ['opaque policy paths fail closed', matchHumanAuthorization([null]).length === 1 && matchMergeProtected([null]).length === 1],
  ];
  for (const fixture of PATH_POLICY_FIXTURES) {
    checks.push([
      `human policy ${fixture.path}`,
      (matchHumanAuthorization([fixture.path]).length > 0) === fixture.humanAuthorization,
    ]);
    checks.push([
      `merge policy ${fixture.path}`,
      (matchMergeProtected([fixture.path]).length > 0) === fixture.mergeProtected,
    ]);
  }
  const failures = checks.filter(([, ok]) => !ok);
  for (const [name] of failures) console.error(`FAIL: ${name}`);
  console.log(failures.length ? `self-test: ${failures.length} FAILED` : `self-test OK (${checks.length} checks)`);
  return failures.length === 0;
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  } catch {
    return false;
  }
})();
if (isMain) process.exit(selfTest() ? 0 : 1);
