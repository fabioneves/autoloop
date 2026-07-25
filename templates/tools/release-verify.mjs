#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const STABLE_SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const OID = /^[0-9a-f]{40,64}$/u;
const RELEASE_TAG_INCLUDE = 'refs/tags/v*';
const GITHUB_API_VERSION = '2026-03-10';
const MAX_RULESETS = 1000;
const MAX_SMOKE_MANIFEST_BYTES = 256 * 1024;
const MAX_SMOKE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SMOKE_TOTAL_BYTES = 32 * 1024 * 1024;
const SMOKE_EVIDENCE_KIND = 'autoloop-opencode-live-smoke-evidence';
const SMOKE_EVIDENCE_ROLES = Object.freeze([
  ...Array.from(
    { length: 9 },
    (_, index) => `check-${String(index + 1).padStart(2, '0')}-stream`,
  ),
  'check-10-origin-stream',
  'check-10-driver-request-issued-stream',
  'check-10-driver-session-created-stream',
  'check-10-driver-context-injected-stream',
  'check-10-server-log',
  'check-10-message-response',
  'check-10-request',
  'check-10-state-issued',
  'check-10-state-claimed',
  'check-10-state-session-created',
  'check-10-state-opened',
  'check-10-state-prompted',
  'check-10-effect-session-create',
  'check-10-effect-context-inject',
  'check-10-effect-prompt',
  'check-10-owner-claim',
  'check-10-owner-session-recovery',
  'check-10-owner-context-recovery',
  'check-10-crash-request-issued',
  'check-10-crash-session-created',
  'check-10-crash-context-injected',
]);
const RELEASE_BASE_POLICY = Object.freeze({
  branch: 'main',
  requiredChecks: Object.freeze([
    Object.freeze({
      context: 'Contracts (macos-latest, Node 24)',
      integrationId: 15368,
    }),
    Object.freeze({
      context: 'Contracts (ubuntu-latest, Node 22)',
      integrationId: 15368,
    }),
  ]),
});
const SKILL_BANNERS = [
  ['setup', 'setupSkill', 'skills/setup/SKILL.md'],
  ['dev', 'devSkill', 'skills/dev/SKILL.md'],
  ['pitcrew', 'pitcrewSkill', 'skills/pitcrew/SKILL.md'],
];

export function compareStableVersions(left, right) {
  if (!STABLE_SEMVER.test(left) || !STABLE_SEMVER.test(right)) {
    throw new TypeError('version comparison requires two stable semantic versions');
  }
  const leftParts = left.split('.').map(BigInt);
  const rightParts = right.split('.').map(BigInt);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] < rightParts[index]) return -1;
    if (leftParts[index] > rightParts[index]) return 1;
  }
  return 0;
}

export function fingerprintBytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function sortContinuationStateNames(names) {
  return names
    .filter((name) => /^state-[0-9]{3}-(?:issued|claimed|session-created|opened|prompted)\.json$/u.test(name))
    .sort();
}

export function listContinuationStates(directory) {
  return sortContinuationStateNames(readdirSync(directory));
}

export function sortStableVersions(text) {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => STABLE_SEMVER.test(line))
    .sort(compareStableVersions);
}

export function verifyReleaseTagBinding(binding) {
  const errors = [];
  const expectedTag = `v${binding?.version ?? ''}`;
  if (!STABLE_SEMVER.test(binding?.version ?? '')) {
    errors.push('release tag binding: VERSION is not stable semantic version');
  }
  if (binding?.tagName !== expectedTag) {
    errors.push(`release tag binding: expected ${expectedTag}`);
  }
  if (binding?.tagObjectType !== 'tag') {
    errors.push('release tag binding: release tag must be annotated');
  }
  if (
    binding?.currentRef !== undefined
    && binding.currentRef !== `refs/tags/${expectedTag}`
  ) {
    errors.push(`release tag binding: current CI ref must be refs/tags/${expectedTag}`);
  }
  if (
    binding?.currentRefName !== undefined
    && binding.currentRefName !== expectedTag
  ) {
    errors.push(`release tag binding: current CI ref name must be ${expectedTag}`);
  }
  if (
    binding?.currentRefType !== undefined
    && binding.currentRefType !== 'tag'
  ) {
    errors.push('release tag binding: current CI ref type must be tag');
  }
  if (binding?.mainRef !== 'refs/remotes/origin/main') {
    errors.push('release tag binding: ancestry must use refs/remotes/origin/main');
  }
  if (!OID.test(binding?.headOid ?? '') || !OID.test(binding?.tagCommitOid ?? '')) {
    errors.push('release tag binding: Git commit identity is unavailable');
  } else if (binding.headOid !== binding.tagCommitOid) {
    errors.push('release tag binding: checked-out HEAD does not equal the tagged commit');
  }
  if (binding?.mainContainsTag !== true) {
    errors.push('release tag binding: tagged commit is not reachable from main');
  }
  return errors;
}

export function verifyReleaseTagRulesets(rulesets) {
  if (!Array.isArray(rulesets)) {
    return ['repository tag policy: ruleset evidence is unavailable'];
  }
  const protectedByNoBypassRuleset = rulesets.some((ruleset) => {
    const refName = ruleset?.conditions?.ref_name;
    const ruleTypes = new Set(
      Array.isArray(ruleset?.rules)
        ? ruleset.rules.map((rule) => rule?.type)
        : [],
    );
    return ruleset?.target === 'tag'
      && ruleset?.enforcement === 'active'
      && Array.isArray(ruleset?.bypass_actors)
      && ruleset.bypass_actors.length === 0
      && Array.isArray(refName?.include)
      && refName.include.includes(RELEASE_TAG_INCLUDE)
      && Array.isArray(refName?.exclude)
      && refName.exclude.length === 0
      && ruleTypes.has('deletion')
      && ruleTypes.has('non_fast_forward');
  });
  return protectedByNoBypassRuleset
    ? []
    : [
      'repository tag policy: expected an active v* tag ruleset with no bypass actors and deletion/non_fast_forward rules',
    ];
}

function completeRulesetEvidence(rulesets) {
  return Array.isArray(rulesets)
    && rulesets.length <= MAX_RULESETS
    && rulesets.every((ruleset) =>
      ruleset
      && typeof ruleset === 'object'
      && !Array.isArray(ruleset)
      && Number.isSafeInteger(ruleset.id)
      && ruleset.id > 0
      && typeof ruleset.name === 'string'
      && ruleset.name.length >= 1
      && ['branch', 'tag', 'push'].includes(ruleset.target)
      && ['active', 'disabled', 'evaluate'].includes(ruleset.enforcement)
      && Array.isArray(ruleset.bypass_actors)
      && ruleset.conditions
      && typeof ruleset.conditions === 'object'
      && !Array.isArray(ruleset.conditions)
      && Array.isArray(ruleset.conditions.ref_name?.include)
      && Array.isArray(ruleset.conditions.ref_name?.exclude)
      && Array.isArray(ruleset.rules));
}

export function verifyConfiguredBaseRulesets(
  rulesets,
  policy = RELEASE_BASE_POLICY,
) {
  if (
    !completeRulesetEvidence(rulesets)
    || typeof policy?.branch !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u.test(policy.branch)
    || !Array.isArray(policy.requiredChecks)
    || policy.requiredChecks.length < 1
    || policy.requiredChecks.some((check) =>
      !exactKeys(check, ['context', 'integrationId'])
      || typeof check.context !== 'string'
      || check.context.length < 1
      || check.context.length > 255
      || !Number.isSafeInteger(check.integrationId)
      || check.integrationId < 1)
    || new Set(policy.requiredChecks.map((check) => check.context)).size
      !== policy.requiredChecks.length
  ) {
    return ['repository base policy: ruleset evidence or expected policy is unavailable or malformed'];
  }
  const expectedRef = `refs/heads/${policy.branch}`;
  const expectedChecks = [...policy.requiredChecks]
    .sort((left, right) => left.context.localeCompare(right.context));
  const protectedByNoBypassRuleset = rulesets.some((ruleset) => {
    if (
      ruleset.target !== 'branch'
      || ruleset.enforcement !== 'active'
      || ruleset.bypass_actors.length !== 0
      || ruleset.conditions.ref_name.include.length !== 1
      || ruleset.conditions.ref_name.include[0] !== expectedRef
      || ruleset.conditions.ref_name.exclude.length !== 0
    ) {
      return false;
    }
    const byType = new Map();
    for (const rule of ruleset.rules) {
      if (
        !rule
        || typeof rule !== 'object'
        || Array.isArray(rule)
        || typeof rule.type !== 'string'
        || byType.has(rule.type)
      ) {
        return false;
      }
      byType.set(rule.type, rule);
    }
    const status = byType.get('required_status_checks')?.parameters;
    const pullRequest = byType.get('pull_request')?.parameters;
    const requiredChecks = Array.isArray(status?.required_status_checks)
      ? status.required_status_checks
        .map((check) => ({
          context: check?.context,
          integrationId: check?.integration_id,
        }))
        .sort((left, right) =>
          String(left.context).localeCompare(String(right.context)))
      : null;
    return byType.has('deletion')
      && byType.has('non_fast_forward')
      && status?.strict_required_status_checks_policy === true
      && Array.isArray(requiredChecks)
      && JSON.stringify(requiredChecks) === JSON.stringify(expectedChecks)
      && Array.isArray(pullRequest?.allowed_merge_methods)
      && pullRequest.allowed_merge_methods.length === 1
      && pullRequest.allowed_merge_methods[0] === 'squash'
      && typeof pullRequest.dismiss_stale_reviews_on_push === 'boolean'
      && typeof pullRequest.require_code_owner_review === 'boolean'
      && typeof pullRequest.require_last_push_approval === 'boolean'
      && Number.isSafeInteger(
        pullRequest.required_approving_review_count,
      )
      && pullRequest.required_approving_review_count >= 0
      && pullRequest.required_review_thread_resolution === true;
  });
  return protectedByNoBypassRuleset
    ? []
    : [
      `repository base policy: expected active no-bypass ${expectedRef} rules requiring pull requests, resolved conversations, strict trusted checks, deletion, and non-fast-forward protection`,
    ];
}

export function verifyImmutableReleases(settings, options = {}) {
  if (
    settings === null
    || typeof settings !== 'object'
    || Array.isArray(settings)
    || typeof settings.enabled !== 'boolean'
    || typeof settings.enforced_by_owner !== 'boolean'
  ) {
    return ['immutable releases: live repository settings are unavailable or malformed'];
  }
  const errors = [];
  if (settings.enabled !== true) {
    errors.push('immutable releases: repository setting must report enabled=true');
  }
  if (
    options.requireOwnerEnforcement === true
    && settings.enforced_by_owner !== true
  ) {
    errors.push('immutable releases: organization owner enforcement is required');
  }
  return errors;
}

function countLiteral(text, literal) {
  if (typeof text !== 'string') return 0;
  return text.split(literal).length - 1;
}

function readConfigVersion(text, errors) {
  const matches = typeof text === 'string'
    ? [...text.matchAll(/^export const CONFIG_VERSION = '([^']+)';$/gmu)]
    : [];
  if (matches.length !== 1 || !STABLE_SEMVER.test(matches[0][1])) {
    errors.push(
      'templates/tools/config-contract.mjs: expected exactly one stable CONFIG_VERSION declaration',
    );
    return null;
  }
  return matches[0][1];
}

function requireReleaseReference(text, path, description, literal, errors) {
  if (countLiteral(text, literal) !== 1) {
    errors.push(`${path}: expected exactly one ${description}`);
  }
}

function exactKeys(value, keys) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function validEvidencePath(path, prefix = '') {
  return typeof path === 'string'
    && path.length >= 1
    && path.length <= 255
    && !path.startsWith('/')
    && !path.startsWith('-')
    && !path.includes('\\')
    && !path.includes('\0')
    && path.split('/').every(
      (part) =>
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(part)
        && part !== '.'
        && part !== '..',
    )
    && (prefix === '' || path.startsWith(prefix));
}

function evidenceFailure(errors, message) {
  errors.push(`docs/opencode-smoke.md: live smoke evidence artifact ${message}`);
}

function validateSmokeEvidenceManifest(
  manifestBytes,
  record,
  version,
  readArtifact,
  errors,
) {
  if (
    !Buffer.isBuffer(manifestBytes)
    || manifestBytes.length < 2
    || manifestBytes.length > MAX_SMOKE_MANIFEST_BYTES
    || fingerprintBytes(manifestBytes) !== record.sha256
  ) {
    evidenceFailure(errors, 'is missing, oversized, or does not match sha256');
    return;
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    evidenceFailure(errors, 'manifest is not valid JSON');
    return;
  }
  if (
    !exactKeys(manifest, [
      'kind',
      'version',
      'release',
      'date',
      'opencode',
      'checks',
      'sanitized',
      'files',
    ])
    || manifest.kind !== SMOKE_EVIDENCE_KIND
    || manifest.version !== 1
    || manifest.release !== version
    || manifest.date !== record.date
    || manifest.opencode !== record.opencode
    || manifest.sanitized !== true
    || !Array.isArray(manifest.checks)
    || manifest.checks.length !== 10
    || manifest.checks.some((check, index) => check !== index + 1)
    || !Array.isArray(manifest.files)
    || manifest.files.length !== SMOKE_EVIDENCE_ROLES.length
  ) {
    evidenceFailure(errors, 'manifest identity or checks 1-10 are incomplete');
    return;
  }
  const roles = new Set();
  const paths = new Set();
  let totalBytes = manifestBytes.length;
  for (const entry of manifest.files) {
    if (
      !exactKeys(entry, ['role', 'path', 'bytes', 'sha256'])
      || !SMOKE_EVIDENCE_ROLES.includes(entry.role)
      || roles.has(entry.role)
      || !validEvidencePath(entry.path, 'files/')
      || paths.has(entry.path)
      || !Number.isSafeInteger(entry.bytes)
      || entry.bytes < 1
      || entry.bytes > MAX_SMOKE_FILE_BYTES
      || !/^[0-9a-f]{64}$/u.test(entry.sha256)
      || /^0{64}$/u.test(entry.sha256)
    ) {
      evidenceFailure(errors, 'manifest inventory is malformed or duplicated');
      return;
    }
    roles.add(entry.role);
    paths.add(entry.path);
    totalBytes += entry.bytes;
    if (totalBytes > MAX_SMOKE_TOTAL_BYTES) {
      evidenceFailure(errors, 'inventory exceeds the bounded evidence size');
      return;
    }
  }
  if (
    SMOKE_EVIDENCE_ROLES.some((role) => !roles.has(role))
    || manifest.files.some(
      (entry, index) =>
        index > 0
        && manifest.files[index - 1].role.localeCompare(entry.role) >= 0,
    )
  ) {
    evidenceFailure(errors, 'manifest inventory roles are incomplete or unordered');
    return;
  }
  for (const entry of manifest.files) {
    let bytes;
    try {
      bytes = readArtifact(
        `${dirname(record.location)}/${entry.path}`,
        MAX_SMOKE_FILE_BYTES,
      );
    } catch {
      evidenceFailure(errors, `inventory member ${entry.path} is unavailable`);
      return;
    }
    if (
      !Buffer.isBuffer(bytes)
      || bytes.length !== entry.bytes
      || fingerprintBytes(bytes) !== entry.sha256
    ) {
      evidenceFailure(errors, `inventory member ${entry.path} does not match`);
      return;
    }
  }
}

function requireOpenCodeSmokeEvidence(
  text,
  version,
  errors,
  readArtifact,
  options = {},
) {
  const matches = typeof text === 'string'
    ? [...text.matchAll(new RegExp(
      `^- v${version.replaceAll('.', '\\.')} live smoke evidence: `
      + 'date=([0-9]{4}-[0-9]{2}-[0-9]{2}); '
      + 'opencode=([^;]+); checks=1-10; '
      + 'sha256=([0-9a-f]{64}); location=([^\\s]+)$',
      'gmu',
    ))]
    : [];
  // An untested declaration states that the ten live checks were deliberately
  // skipped for this release. It carries the release instead of blocking it, but
  // it is always reported as a note and never as a passed live route.
  const untested = typeof text === 'string'
    ? [...text.matchAll(new RegExp(
      `^- v${version.replaceAll('.', '\\.')} live smoke evidence: untested$`,
      'gmu',
    ))].length
    : 0;
  if (matches.length === 0 && untested === 1) {
    options.note?.(
      `docs/opencode-smoke.md: v${version} OpenCode live smoke is declared untested`,
    );
    return;
  }
  if (untested > 0) {
    errors.push(
      `docs/opencode-smoke.md: expected exactly one complete v${version} live smoke evidence record`,
    );
    return;
  }
  const match = matches[0];
  const date = match ? new Date(`${match[1]}T00:00:00Z`) : null;
  const valid = matches.length === 1
    && date !== null
    && !Number.isNaN(date.getTime())
    && date.toISOString().slice(0, 10) === match[1]
    && STABLE_SEMVER.test(match[2])
    && !/^0{64}$/u.test(match[3])
    && validEvidencePath(match[4], 'evidence/')
    && match[4].endsWith('/manifest.json');
  if (!valid) {
    errors.push(
      `docs/opencode-smoke.md: expected exactly one complete v${version} live smoke evidence record`,
    );
    return;
  }
  if (typeof readArtifact !== 'function') {
    evidenceFailure(errors, 'reader is unavailable');
    return;
  }
  const record = {
    date: match[1],
    opencode: match[2],
    sha256: match[3],
    location: match[4],
  };
  let manifestBytes;
  try {
    manifestBytes = readArtifact(record.location, MAX_SMOKE_MANIFEST_BYTES);
  } catch {
    evidenceFailure(errors, 'is not one committed regular non-symlink file');
    return;
  }
  validateSmokeEvidenceManifest(
    manifestBytes,
    record,
    version,
    readArtifact,
    errors,
  );
}

function readVersionedManifest(text, path, version, errors) {
  if (typeof text !== 'string') {
    errors.push(`${path}: missing`);
    return;
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    errors.push(`${path}: invalid JSON`);
    return;
  }
  if (manifest.version !== version) errors.push(`${path}: version must equal ${version}`);
}

function readJsonDocument(text, path, errors) {
  if (typeof text !== 'string') {
    errors.push(`${path}: missing`);
    return;
  }
  try {
    JSON.parse(text);
  } catch {
    errors.push(`${path}: invalid JSON`);
  }
}

function requireReleaseWorkflow(text, errors) {
  const requirements = [
    ['--release-mode', '--release-mode release gate'],
    ['--check-tag-policy', '--check-tag-policy release gate'],
    ['--check-base-policy', '--check-base-policy release gate'],
    [
      '--check-immutable-releases',
      '--check-immutable-releases release gate',
    ],
    [
      '--repository "$GITHUB_REPOSITORY"',
      'checkout-bound repository argument',
    ],
    ['--base-branch main', 'configured base branch argument'],
    [
      '--required-check "Contracts (macos-latest, Node 24)@15368"',
      'macOS trusted status check argument',
    ],
    [
      '--required-check "Contracts (ubuntu-latest, Node 22)@15368"',
      'Linux trusted status check argument',
    ],
    [
      'AUTOLOOP_RELEASE_POLICY_TOKEN: ${{ secrets.AUTOLOOP_RELEASE_POLICY_TOKEN || github.token }}',
      'release policy token with github.token fallback',
    ],
  ];
  for (const [literal, description] of requirements) {
    if (countLiteral(text, literal) !== 1) {
      errors.push(
        `.github/workflows/verify.yml: expected exactly one ${description}`,
      );
    }
  }
}

export function verifyRelease(files, options = {}) {
  const errors = [];
  const rawVersion = files?.VERSION;
  const version = typeof rawVersion === 'string' ? rawVersion.trim() : '';
  if (
    !STABLE_SEMVER.test(version)
    || rawVersion !== `${version}\n`
  ) {
    return ['VERSION: expected one stable semantic version'];
  }

  readVersionedManifest(
    files.claudeManifest,
    '.claude-plugin/plugin.json',
    version,
    errors,
  );
  readJsonDocument(files.agentsMarketplace, '.agents/plugins/marketplace.json', errors);
  readJsonDocument(files.claudeMarketplace, '.claude-plugin/marketplace.json', errors);
  readVersionedManifest(
    files.codexManifest,
    '.codex-plugin/plugin.json',
    version,
    errors,
  );
  requireReleaseWorkflow(files.verifyWorkflow, errors);

  const releaseBadge = `<img alt="release v${version}" src="https://img.shields.io/badge/release-v${version}-8b5cf6?style=flat-square">`;
  if (countLiteral(files.README, releaseBadge) !== 1) {
    errors.push(`README.md: expected exactly one v${version} release badge`);
  }

  const changelogHeading = `## [${version}] - `;
  const changelogMatches = typeof files.changelog === 'string'
    ? files.changelog.split('\n').filter(
      (line) => line.startsWith(changelogHeading)
        && /^## \[[^\]]+\] - [0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(line),
    ).length
    : 0;
  if (changelogMatches !== 1) {
    errors.push(`CHANGELOG.md: expected one dated ${version} release heading`);
  }

  for (const [skill, key, path] of SKILL_BANNERS) {
    const banner = `∞ ${skill} · v${version} · starting`;
    if (countLiteral(files[key], banner) !== 1) {
      errors.push(`${path}: expected exactly one v${version} startup banner`);
    }
  }

  const configVersion = readConfigVersion(files.configContract, errors);
  requireReleaseReference(
    files.README,
    'README.md',
    `v${version} route-matrix release reference`,
    `v${version} supports exactly five active-host/captured-preference pairs:`,
    errors,
  );
  requireReleaseReference(
    files.measurementDoc,
    'docs/measurement.md',
    `v${version} release reference`,
    `The pipeline is implemented in v${version}.`,
    errors,
  );
  const readArtifact = options.readEvidenceArtifact
    ?? (typeof options.root === 'string'
      ? (path, maximumBytes) =>
        readCommittedEvidenceArtifact(options.root, path, maximumBytes)
      : files.evidenceArtifacts instanceof Map
        ? (path, maximumBytes) => {
          const value = files.evidenceArtifacts.get(path);
          if (!Buffer.isBuffer(value) || value.length > maximumBytes) {
            throw new Error('fixture evidence artifact is unavailable');
          }
          return value;
        }
        : undefined);
  requireOpenCodeSmokeEvidence(
    files.opencodeSmoke,
    version,
    errors,
    readArtifact,
    { note: options.note },
  );
  if (configVersion !== null) {
    requireReleaseReference(
      files.README,
      'README.md',
      `v${version}/schema ${configVersion} reference`,
      `v${version} uses schema \`${configVersion}\`.`,
      errors,
    );
    requireReleaseReference(
      files.stateTemplate,
      'templates/STATE.template.md',
      `v${version}/schema ${configVersion} reference`,
      `v${version} requires \`${configVersion}\`.`,
      errors,
    );
  }

  for (const [path, text] of Object.entries(files.portabilitySurfaces ?? {}).sort()) {
    if (/\bsort[ \t]+-V\b/u.test(text)) {
      errors.push(`${path}: use a portable Node version comparator instead of sort -V`);
    }
    if (/\bfind\b[^\r\n]*[ \t]-printf\b/u.test(text)) {
      errors.push(`${path}: use portable file listing instead of find -printf`);
    }
    for (const command of ['sha1sum', 'sha256sum']) {
      if (new RegExp(`\\b${command}\\b`, 'u').test(text)) {
        errors.push(`${path}: use a portable Node fingerprint instead of ${command}`);
      }
    }
  }

  return errors;
}

function fixtureSmokeEvidence(version) {
  const location = `evidence/opencode-v${version}/manifest.json`;
  const evidenceArtifacts = new Map();
  const files = [...SMOKE_EVIDENCE_ROLES].sort().map((role) => {
    const path = `files/${role}.txt`;
    const bytes = Buffer.from(`${role}\n`);
    evidenceArtifacts.set(
      `${dirname(location)}/${path}`,
      bytes,
    );
    return {
      role,
      path,
      bytes: bytes.length,
      sha256: fingerprintBytes(bytes),
    };
  });
  const manifestBytes = Buffer.from(`${JSON.stringify({
    kind: SMOKE_EVIDENCE_KIND,
    version: 1,
    release: version,
    date: '2026-07-25',
    opencode: '1.18.4',
    checks: Array.from({ length: 10 }, (_, index) => index + 1),
    sanitized: true,
    files,
  }, null, 2)}\n`);
  evidenceArtifacts.set(location, manifestBytes);
  return {
    evidenceArtifacts,
    location,
    sha256: fingerprintBytes(manifestBytes),
  };
}

function fixtureFiles(version = '0.40.0') {
  const evidence = fixtureSmokeEvidence(version);
  return {
    VERSION: `${version}\n`,
    README: [
      `<img alt="release v${version}" src="https://img.shields.io/badge/release-v${version}-8b5cf6?style=flat-square">`,
      `v${version} supports exactly five active-host/captured-preference pairs:`,
      `v${version} uses schema \`0.25.0\`.`,
      '',
    ].join('\n'),
    claudeManifest: JSON.stringify({ name: 'autoloop', version }),
    codexManifest: JSON.stringify({ name: 'autoloop', version }),
    agentsMarketplace: JSON.stringify({ name: 'autoloop', plugins: [] }),
    claudeMarketplace: JSON.stringify({ name: 'autoloop', plugins: [] }),
    changelog: `# Changelog\n\n## [${version}] - 2026-07-24\n`,
    setupSkill: `∞ setup · v${version} · starting\n`,
    devSkill: `∞ dev · v${version} · starting\n`,
    pitcrewSkill: `∞ pitcrew · v${version} · starting\n`,
    configContract: "export const CONFIG_VERSION = '0.25.0';\n",
    measurementDoc: `The pipeline is implemented in v${version}.\n`,
    opencodeSmoke:
      `- v${version} live smoke evidence: date=2026-07-25; `
      + `opencode=1.18.4; checks=1-10; sha256=${evidence.sha256}; `
      + `location=${evidence.location}\n`,
    evidenceArtifacts: evidence.evidenceArtifacts,
    stateTemplate: `v${version} requires \`0.25.0\`.\n`,
    verifyWorkflow: [
      'AUTOLOOP_RELEASE_POLICY_TOKEN: ${{ secrets.AUTOLOOP_RELEASE_POLICY_TOKEN || github.token }}',
      '--release-mode',
      '--check-tag-policy',
      '--check-base-policy',
      '--check-immutable-releases',
      '--repository "$GITHUB_REPOSITORY"',
      '--base-branch main',
      '--required-check "Contracts (macos-latest, Node 24)@15368"',
      '--required-check "Contracts (ubuntu-latest, Node 22)@15368"',
      '',
    ].join('\n'),
    portabilitySurfaces: {
      'skills/setup/SKILL.md': 'portable release selection\n',
      'skills/dev/SKILL.md': 'portable fingerprint helper\n',
      'templates/STATE.template.md': 'portable fingerprint helper\n',
    },
  };
}

function mutatedFixtureManifest(mutate) {
  const files = fixtureFiles();
  const location = [...files.evidenceArtifacts.keys()].find(
    (path) => path.endsWith('/manifest.json'),
  );
  const manifest = JSON.parse(
    files.evidenceArtifacts.get(location).toString('utf8'),
  );
  mutate(manifest);
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  files.evidenceArtifacts = new Map(files.evidenceArtifacts);
  files.evidenceArtifacts.set(location, bytes);
  files.opencodeSmoke = files.opencodeSmoke.replace(
    /sha256=[0-9a-f]{64}/u,
    `sha256=${fingerprintBytes(bytes)}`,
  );
  return files;
}

function fixtureTagRuleset(overrides = {}) {
  return {
    id: 40,
    name: 'release tags',
    target: 'tag',
    enforcement: 'active',
    bypass_actors: [],
    conditions: {
      ref_name: {
        include: [RELEASE_TAG_INCLUDE],
        exclude: [],
      },
    },
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
    ],
    ...overrides,
  };
}

function fixtureBaseRuleset(overrides = {}) {
  return {
    id: 41,
    name: 'configured base',
    target: 'branch',
    enforcement: 'active',
    bypass_actors: [],
    conditions: {
      ref_name: {
        include: ['refs/heads/main'],
        exclude: [],
      },
    },
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      {
        type: 'pull_request',
        parameters: {
          allowed_merge_methods: ['squash'],
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_approving_review_count: 0,
          required_review_thread_resolution: true,
        },
      },
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: RELEASE_BASE_POLICY.requiredChecks.map(
            (check) => ({
              context: check.context,
              integration_id: check.integrationId,
            }),
          ),
        },
      },
    ],
    ...overrides,
  };
}

function realEvidenceReaderSelfTest() {
  const root = mkdtempSync(join(tmpdir(), 'autoloop-release-evidence-'));
  try {
    const files = fixtureFiles();
    for (const [path, bytes] of files.evidenceArtifacts) {
      mkdirSync(dirname(resolve(root, path)), { recursive: true });
      writeFileSync(resolve(root, path), bytes);
    }
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', 'evidence'], { cwd: root });
    execFileSync('git', [
      '-c',
      'user.name=Autoloop',
      '-c',
      'user.email=autoloop@example.invalid',
      'commit',
      '-qm',
      'fixture evidence',
    ], { cwd: root });
    const validErrors = verifyRelease(files, { root });
    let nonexistentRejected = false;
    try {
      readCommittedEvidenceArtifact(
        root,
        'evidence/does-not-exist.json',
        MAX_SMOKE_MANIFEST_BYTES,
      );
    } catch {
      nonexistentRejected = true;
    }
    const linkPath = resolve(root, 'evidence', 'linked-manifest.json');
    symlinkSync('opencode-v0.40.0/manifest.json', linkPath);
    execFileSync('git', ['add', 'evidence/linked-manifest.json'], { cwd: root });
    execFileSync('git', [
      '-c',
      'user.name=Autoloop',
      '-c',
      'user.email=autoloop@example.invalid',
      'commit',
      '-qm',
      'fixture symlink',
    ], { cwd: root });
    let symlinkRejected = false;
    try {
      readCommittedEvidenceArtifact(
        root,
        'evidence/linked-manifest.json',
        MAX_SMOKE_MANIFEST_BYTES,
      );
    } catch {
      symlinkRejected = true;
    }
    return {
      valid: validErrors.length === 0,
      nonexistentRejected,
      symlinkRejected,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function selfTest() {
  const cases = [
    {
      name: 'accepts one synchronized release',
      files: fixtureFiles(),
      expected: [],
    },
    {
      name: 'rejects an invalid canonical version',
      files: fixtureFiles('v0.40.0'),
      expected: ['VERSION: expected one stable semantic version'],
    },
    {
      name: 'rejects a manifest mismatch',
      files: {
        ...fixtureFiles(),
        codexManifest: JSON.stringify({ name: 'autoloop', version: '0.39.9' }),
      },
      expected: ['.codex-plugin/plugin.json: version must equal 0.40.0'],
    },
    {
      name: 'rejects a stale skill banner',
      files: {
        ...fixtureFiles(),
        devSkill: '∞ dev · v0.39.9 · starting\n',
      },
      expected: ['skills/dev/SKILL.md: expected exactly one v0.40.0 startup banner'],
    },
    {
      name: 'rejects stale forward release references',
      files: {
        ...fixtureFiles('0.40.1'),
        README: [
          '<img alt="release v0.40.1" src="https://img.shields.io/badge/release-v0.40.1-8b5cf6?style=flat-square">',
          'v0.40.0 supports exactly five active-host/captured-preference pairs:',
          'v0.40.0 uses schema `0.25.0`.',
          '',
        ].join('\n'),
        measurementDoc: 'The pipeline is implemented in v0.40.0.\n',
        opencodeSmoke:
          `- v0.40.0 live smoke evidence: date=2026-07-25; `
          + `opencode=1.18.4; checks=1-10; sha256=${'a'.repeat(64)}; `
          + 'location=evidence/opencode-v0.40.0.tar\n',
        stateTemplate: 'v0.40.0 requires `0.25.0`.\n',
      },
      expected: [
        'README.md: expected exactly one v0.40.1 route-matrix release reference',
        'docs/measurement.md: expected exactly one v0.40.1 release reference',
        'docs/opencode-smoke.md: expected exactly one complete v0.40.1 live smoke evidence record',
        'README.md: expected exactly one v0.40.1/schema 0.25.0 reference',
        'templates/STATE.template.md: expected exactly one v0.40.1/schema 0.25.0 reference',
      ],
    },
    {
      name: 'derives documented schema references from the contract',
      files: {
        ...fixtureFiles(),
        configContract: "export const CONFIG_VERSION = '0.26.0';\n",
      },
      expected: [
        'README.md: expected exactly one v0.40.0/schema 0.26.0 reference',
        'templates/STATE.template.md: expected exactly one v0.40.0/schema 0.26.0 reference',
      ],
    },
    {
      name: 'rejects non-portable release and fingerprint helpers',
      files: {
        ...fixtureFiles(),
        portabilitySurfaces: {
          'docs/opencode-smoke.md':
            "find \"$LEASE_DIR\" -name 'state-*.json' -printf '%f\\n'\nsha256sum\n",
          'skills/setup/SKILL.md': 'sort -V',
          'skills/dev/SKILL.md': 'sha1sum',
        },
      },
      expected: [
        'docs/opencode-smoke.md: use portable file listing instead of find -printf',
        'docs/opencode-smoke.md: use a portable Node fingerprint instead of sha256sum',
        'skills/dev/SKILL.md: use a portable Node fingerprint instead of sha1sum',
        'skills/setup/SKILL.md: use a portable Node version comparator instead of sort -V',
      ],
    },
    {
      name: 'reports malformed JSON without throwing',
      files: {
        ...fixtureFiles(),
        claudeManifest: '{',
      },
      expected: ['.claude-plugin/plugin.json: invalid JSON'],
    },
    {
      name: 'rejects incomplete current OpenCode smoke evidence',
      files: {
        ...fixtureFiles(),
        opencodeSmoke:
          '- v0.40.0 live smoke evidence: date=2026-07-25; '
          + 'opencode=1.18.4; checks=1-10; sha256=pending; location=pending\n',
      },
      expected: [
        'docs/opencode-smoke.md: expected exactly one complete v0.40.0 live smoke evidence record',
      ],
    },
    {
      name: 'carries an untested OpenCode smoke declaration as a note',
      files: {
        ...fixtureFiles(),
        opencodeSmoke: '- v0.40.0 live smoke evidence: untested\n',
      },
      expected: [],
      expectedNotes: [
        'docs/opencode-smoke.md: v0.40.0 OpenCode live smoke is declared untested',
      ],
    },
    {
      name: 'rejects an untested declaration beside a complete record',
      files: (() => {
        const files = fixtureFiles();
        return {
          ...files,
          opencodeSmoke:
            `${files.opencodeSmoke}- v0.40.0 live smoke evidence: untested\n`,
        };
      })(),
      expected: [
        'docs/opencode-smoke.md: expected exactly one complete v0.40.0 live smoke evidence record',
      ],
    },
    {
      name: 'rejects a duplicated untested declaration',
      files: {
        ...fixtureFiles(),
        opencodeSmoke:
          '- v0.40.0 live smoke evidence: untested\n'
          + '- v0.40.0 live smoke evidence: untested\n',
      },
      expected: [
        'docs/opencode-smoke.md: expected exactly one complete v0.40.0 live smoke evidence record',
      ],
    },
    {
      name: 'rejects nonexistent OpenCode smoke evidence artifacts',
      files: (() => {
        const files = fixtureFiles();
        files.evidenceArtifacts = new Map(files.evidenceArtifacts);
        const location = [...files.evidenceArtifacts.keys()].find(
          (path) => path.endsWith('/manifest.json'),
        );
        files.evidenceArtifacts.delete(location);
        return files;
      })(),
      expected: [
        'docs/opencode-smoke.md: live smoke evidence artifact is not one committed regular non-symlink file',
      ],
    },
    {
      name: 'rejects OpenCode smoke evidence digest mismatch',
      files: (() => {
        const files = fixtureFiles();
        files.opencodeSmoke = files.opencodeSmoke.replace(
          /sha256=[0-9a-f]{64}/u,
          `sha256=${'b'.repeat(64)}`,
        );
        return files;
      })(),
      expected: [
        'docs/opencode-smoke.md: live smoke evidence artifact is missing, oversized, or does not match sha256',
      ],
    },
    {
      name: 'rejects incomplete OpenCode smoke evidence inventory',
      files: mutatedFixtureManifest((manifest) => {
        manifest.files.pop();
      }),
      expected: [
        'docs/opencode-smoke.md: live smoke evidence artifact manifest identity or checks 1-10 are incomplete',
      ],
    },
    {
      name: 'rejects duplicate OpenCode smoke evidence paths',
      files: mutatedFixtureManifest((manifest) => {
        manifest.files[1].path = manifest.files[0].path;
      }),
      expected: [
        'docs/opencode-smoke.md: live smoke evidence artifact manifest inventory is malformed or duplicated',
      ],
    },
    {
      name: 'rejects traversing OpenCode smoke evidence locations',
      files: (() => {
        const files = fixtureFiles();
        files.opencodeSmoke = files.opencodeSmoke.replace(
          /location=[^\s]+/u,
          'location=evidence/../manifest.json',
        );
        return files;
      })(),
      expected: [
        'docs/opencode-smoke.md: expected exactly one complete v0.40.0 live smoke evidence record',
      ],
    },
    {
      name: 'requires tag CI to invoke all live release controls',
      files: {
        ...fixtureFiles(),
        verifyWorkflow: [
          'AUTOLOOP_RELEASE_POLICY_TOKEN: ${{ secrets.AUTOLOOP_RELEASE_POLICY_TOKEN || github.token }}',
          '--release-mode',
          '--check-base-policy',
          '--repository "$GITHUB_REPOSITORY"',
          '--base-branch main',
          '--required-check "Contracts (macos-latest, Node 24)@15368"',
          '--required-check "Contracts (ubuntu-latest, Node 22)@15368"',
          '',
        ].join('\n'),
      },
      expected: [
        '.github/workflows/verify.yml: expected exactly one --check-tag-policy release gate',
        '.github/workflows/verify.yml: expected exactly one --check-immutable-releases release gate',
      ],
    },
  ];

  let failed = 0;
  for (const fixture of cases) {
    const notes = [];
    const actual = verifyRelease(fixture.files, {
      ...fixture.options,
      note: (text) => notes.push(text),
    });
    const passed = JSON.stringify(actual) === JSON.stringify(fixture.expected)
      && JSON.stringify(notes) === JSON.stringify(fixture.expectedNotes ?? []);
    process.stdout.write(`${passed ? 'ok' : 'not ok'} - ${fixture.name}\n`);
    if (!passed) {
      process.stdout.write(
        `  expected: ${JSON.stringify(fixture.expected)}`
        + ` notes ${JSON.stringify(fixture.expectedNotes ?? [])}\n`,
      );
      process.stdout.write(
        `  actual:   ${JSON.stringify(actual)} notes ${JSON.stringify(notes)}\n`,
      );
      failed += 1;
    }
  }

  const helperCases = [
    {
      name: 'sorts semantic versions numerically',
      actual: () => sortStableVersions('0.9.12\nnot-a-version\n0.40.0\n0.10.0\n'),
      expected: ['0.9.12', '0.10.0', '0.40.0'],
    },
    {
      name: 'fingerprints stdin bytes with SHA-256',
      actual: () => fingerprintBytes('autoloop\n'),
      expected: '1d97d9387bfbffa7a4b7abbf1385493f19f0c4e556582afb61f5c2ce41551053',
    },
    {
      name: 'binds an annotated release tag to its main-reachable commit',
      actual: () => verifyReleaseTagBinding({
        version: '0.40.0',
        tagName: 'v0.40.0',
        tagObjectType: 'tag',
        mainRef: 'refs/remotes/origin/main',
        headOid: 'a'.repeat(40),
        tagCommitOid: 'a'.repeat(40),
        mainContainsTag: true,
        currentRef: 'refs/tags/v0.40.0',
        currentRefName: 'v0.40.0',
        currentRefType: 'tag',
      }),
      expected: [],
    },
    {
      name: 'rejects a lightweight off-main release tag',
      actual: () => verifyReleaseTagBinding({
        version: '0.40.0',
        tagName: 'v0.40.0',
        tagObjectType: 'commit',
        mainRef: 'refs/remotes/origin/main',
        headOid: 'a'.repeat(40),
        tagCommitOid: 'a'.repeat(40),
        mainContainsTag: false,
      }),
      expected: [
        'release tag binding: release tag must be annotated',
        'release tag binding: tagged commit is not reachable from main',
      ],
    },
    {
      name: 'rejects a release tag for another version or commit',
      actual: () => verifyReleaseTagBinding({
        version: '0.40.0',
        tagName: 'v0.40.1',
        tagObjectType: 'tag',
        mainRef: 'refs/remotes/origin/main',
        headOid: 'a'.repeat(40),
        tagCommitOid: 'b'.repeat(40),
        mainContainsTag: true,
      }),
      expected: [
        'release tag binding: expected v0.40.0',
        'release tag binding: checked-out HEAD does not equal the tagged commit',
      ],
    },
    {
      name: 'rejects a release-mode argument detached from the CI tag ref',
      actual: () => verifyReleaseTagBinding({
        version: '0.40.0',
        tagName: 'v0.40.0',
        tagObjectType: 'tag',
        mainRef: 'refs/remotes/origin/main',
        headOid: 'a'.repeat(40),
        tagCommitOid: 'a'.repeat(40),
        mainContainsTag: true,
        currentRef: 'refs/heads/main',
        currentRefName: 'main',
        currentRefType: 'branch',
      }),
      expected: [
        'release tag binding: current CI ref must be refs/tags/v0.40.0',
        'release tag binding: current CI ref name must be v0.40.0',
        'release tag binding: current CI ref type must be tag',
      ],
    },
    {
      name: 'accepts an active no-bypass release-tag ruleset',
      actual: () => verifyReleaseTagRulesets([fixtureTagRuleset()]),
      expected: [],
    },
    {
      name: 'rejects bypassable release-tag controls',
      actual: () => verifyReleaseTagRulesets([
        fixtureTagRuleset({
          bypass_actors: [{ actor_type: 'RepositoryRole', actor_id: 5 }],
        }),
      ]),
      expected: [
        'repository tag policy: expected an active v* tag ruleset with no bypass actors and deletion/non_fast_forward rules',
      ],
    },
    {
      name: 'rejects redacted bypass evidence',
      actual: () => verifyReleaseTagRulesets([
        fixtureTagRuleset({ bypass_actors: null }),
      ]),
      expected: [
        'repository tag policy: expected an active v* tag ruleset with no bypass actors and deletion/non_fast_forward rules',
      ],
    },
    {
      name: 'rejects incomplete release-tag rules',
      actual: () => verifyReleaseTagRulesets([
        fixtureTagRuleset({
          rules: [{ type: 'deletion' }],
        }),
      ]),
      expected: [
        'repository tag policy: expected an active v* tag ruleset with no bypass actors and deletion/non_fast_forward rules',
      ],
    },
    {
      name: 'accepts an active no-bypass configured-base ruleset',
      actual: () => verifyConfiguredBaseRulesets([fixtureBaseRuleset()]),
      expected: [],
    },
    {
      name: 'rejects bypassable configured-base controls',
      actual: () => verifyConfiguredBaseRulesets([
        fixtureBaseRuleset({
          bypass_actors: [{ actor_type: 'RepositoryRole', actor_id: 5 }],
        }),
      ]),
      expected: [
        'repository base policy: expected active no-bypass refs/heads/main rules requiring pull requests, resolved conversations, strict trusted checks, deletion, and non-fast-forward protection',
      ],
    },
    {
      name: 'rejects redacted configured-base ruleset evidence',
      actual: () => verifyConfiguredBaseRulesets([
        fixtureBaseRuleset({ bypass_actors: null }),
      ]),
      expected: [
        'repository base policy: ruleset evidence or expected policy is unavailable or malformed',
      ],
    },
    {
      name: 'rejects configured-base controls without pull requests',
      actual: () => verifyConfiguredBaseRulesets([
        fixtureBaseRuleset({
          rules: fixtureBaseRuleset().rules.filter(
            (rule) => rule.type !== 'pull_request',
          ),
        }),
      ]),
      expected: [
        'repository base policy: expected active no-bypass refs/heads/main rules requiring pull requests, resolved conversations, strict trusted checks, deletion, and non-fast-forward protection',
      ],
    },
    {
      name: 'rejects configured-base controls without history protection',
      actual: () => verifyConfiguredBaseRulesets([
        fixtureBaseRuleset({
          rules: fixtureBaseRuleset().rules.filter(
            (rule) => rule.type !== 'non_fast_forward',
          ),
        }),
      ]),
      expected: [
        'repository base policy: expected active no-bypass refs/heads/main rules requiring pull requests, resolved conversations, strict trusted checks, deletion, and non-fast-forward protection',
      ],
    },
    {
      name: 'rejects inactive configured-base controls',
      actual: () => verifyConfiguredBaseRulesets([
        fixtureBaseRuleset({ enforcement: 'evaluate' }),
      ]),
      expected: [
        'repository base policy: expected active no-bypass refs/heads/main rules requiring pull requests, resolved conversations, strict trusted checks, deletion, and non-fast-forward protection',
      ],
    },
    {
      name: 'rejects configured-base merge-method weakening',
      actual: () => verifyConfiguredBaseRulesets([
        fixtureBaseRuleset({
          rules: fixtureBaseRuleset().rules.map((rule) =>
            rule.type === 'pull_request'
              ? {
                ...rule,
                parameters: {
                  ...rule.parameters,
                  allowed_merge_methods: ['merge', 'squash'],
                },
              }
              : rule),
        }),
      ]),
      expected: [
        'repository base policy: expected active no-bypass refs/heads/main rules requiring pull requests, resolved conversations, strict trusted checks, deletion, and non-fast-forward protection',
      ],
    },
    {
      name: 'rejects unresolved configured-base conversations',
      actual: () => verifyConfiguredBaseRulesets([
        fixtureBaseRuleset({
          rules: fixtureBaseRuleset().rules.map((rule) =>
            rule.type === 'pull_request'
              ? {
                ...rule,
                parameters: {
                  ...rule.parameters,
                  required_review_thread_resolution: false,
                },
              }
              : rule),
        }),
      ]),
      expected: [
        'repository base policy: expected active no-bypass refs/heads/main rules requiring pull requests, resolved conversations, strict trusted checks, deletion, and non-fast-forward protection',
      ],
    },
    {
      name: 'rejects non-strict configured-base status checks',
      actual: () => verifyConfiguredBaseRulesets([
        fixtureBaseRuleset({
          rules: fixtureBaseRuleset().rules.map((rule) =>
            rule.type === 'required_status_checks'
              ? {
                ...rule,
                parameters: {
                  ...rule.parameters,
                  strict_required_status_checks_policy: false,
                },
              }
              : rule),
        }),
      ]),
      expected: [
        'repository base policy: expected active no-bypass refs/heads/main rules requiring pull requests, resolved conversations, strict trusted checks, deletion, and non-fast-forward protection',
      ],
    },
    {
      name: 'rejects untrusted configured-base check producers',
      actual: () => verifyConfiguredBaseRulesets([
        fixtureBaseRuleset({
          rules: fixtureBaseRuleset().rules.map((rule) =>
            rule.type === 'required_status_checks'
              ? {
                ...rule,
                parameters: {
                  ...rule.parameters,
                  required_status_checks:
                    rule.parameters.required_status_checks.map(
                      (check, index) => index === 0
                        ? { ...check, integration_id: 1 }
                        : check,
                    ),
                },
              }
              : rule),
        }),
      ]),
      expected: [
        'repository base policy: expected active no-bypass refs/heads/main rules requiring pull requests, resolved conversations, strict trusted checks, deletion, and non-fast-forward protection',
      ],
    },
    {
      name: 'rejects incomplete configured-base check names',
      actual: () => verifyConfiguredBaseRulesets([
        fixtureBaseRuleset({
          rules: fixtureBaseRuleset().rules.map((rule) =>
            rule.type === 'required_status_checks'
              ? {
                ...rule,
                parameters: {
                  ...rule.parameters,
                  required_status_checks:
                    rule.parameters.required_status_checks.slice(1),
                },
              }
              : rule),
        }),
      ]),
      expected: [
        'repository base policy: expected active no-bypass refs/heads/main rules requiring pull requests, resolved conversations, strict trusted checks, deletion, and non-fast-forward protection',
      ],
    },
    {
      name: 'rejects configured-base rules for another branch',
      actual: () => verifyConfiguredBaseRulesets([
        fixtureBaseRuleset({
          conditions: {
            ref_name: {
              include: ['refs/heads/release'],
              exclude: [],
            },
          },
        }),
      ]),
      expected: [
        'repository base policy: expected active no-bypass refs/heads/main rules requiring pull requests, resolved conversations, strict trusted checks, deletion, and non-fast-forward protection',
      ],
    },
    {
      name: 'rejects incomplete configured-base review evidence',
      actual: () => verifyConfiguredBaseRulesets([
        fixtureBaseRuleset({
          rules: fixtureBaseRuleset().rules.map((rule) => {
            if (rule.type !== 'pull_request') return rule;
            const parameters = { ...rule.parameters };
            delete parameters.require_last_push_approval;
            return { ...rule, parameters };
          }),
        }),
      ]),
      expected: [
        'repository base policy: expected active no-bypass refs/heads/main rules requiring pull requests, resolved conversations, strict trusted checks, deletion, and non-fast-forward protection',
      ],
    },
    {
      name: 'accepts enabled repository immutable releases',
      actual: () => verifyImmutableReleases({
        enabled: true,
        enforced_by_owner: false,
      }),
      expected: [],
    },
    {
      name: 'rejects disabled repository immutable releases',
      actual: () => verifyImmutableReleases({
        enabled: false,
        enforced_by_owner: false,
      }),
      expected: [
        'immutable releases: repository setting must report enabled=true',
      ],
    },
    {
      name: 'rejects incomplete immutable release evidence',
      actual: () => verifyImmutableReleases({ enabled: true }),
      expected: [
        'immutable releases: live repository settings are unavailable or malformed',
      ],
    },
    {
      name: 'requires owner enforcement when organization policy is expected',
      actual: () => verifyImmutableReleases(
        { enabled: true, enforced_by_owner: false },
        { requireOwnerEnforcement: true },
      ),
      expected: [
        'immutable releases: organization owner enforcement is required',
      ],
    },
    {
      name: 'accepts immutable releases enforced by the owner',
      actual: () => verifyImmutableReleases(
        { enabled: true, enforced_by_owner: true },
        { requireOwnerEnforcement: true },
      ),
      expected: [],
    },
    {
      name: 'immutable release reads require explicit live API authentication',
      actual: async () => {
        try {
          await readImmutableReleases('owner/repository', undefined, async () => {
            throw new Error('request must not run');
          });
          return 'accepted';
        } catch (error) {
          return error.message;
        }
      },
      expected:
        'immutable releases: authenticated GitHub API token is required '
        + '(Administration repository read)',
    },
    {
      name: 'composite live release controls exercise base, tag, and immutable policy',
      actual: async () => {
        const calls = [];
        const errors = await verifyLiveReleaseControls({
          repository: 'owner/repository',
          token: 'test-token',
          requireOwnerEnforcement: true,
        }, {
          readRulesets: async () => {
            calls.push('tag');
            return [fixtureTagRuleset(), fixtureBaseRuleset()];
          },
          readImmutable: async () => {
            calls.push('immutable');
            return { enabled: true, enforced_by_owner: true };
          },
        });
        return { calls: calls.sort(), errors };
      },
      expected: { calls: ['immutable', 'tag'], errors: [] },
    },
    {
      name: 'lists only ordered durable continuation states',
      actual: () => sortContinuationStateNames([
        'state-004-prompted.json',
        'request.json',
        'state-000-issued.json',
        'state-003-opened.json',
      ]),
      expected: [
        'state-000-issued.json',
        'state-003-opened.json',
        'state-004-prompted.json',
      ],
    },
    {
      name: 'parses only exact GitHub origin repositories',
      actual: () => [
        repositorySlugFromRemote('git@github.com:owner/repository.git'),
        repositorySlugFromRemote('https://github.com/owner/repository'),
        repositorySlugFromRemote('https://example.com/owner/repository'),
      ],
      expected: [
        'owner/repository',
        'owner/repository',
        null,
      ],
    },
    {
      name: 'validates committed evidence and rejects nonexistent or symlink roots',
      actual: () => realEvidenceReaderSelfTest(),
      expected: {
        valid: true,
        nonexistentRejected: true,
        symlinkRejected: true,
      },
    },
    {
      name: 'release base policy arguments cannot weaken committed checks',
      actual: () => {
        const exact = releaseBasePolicyArgs([
          '--base-branch',
          'main',
          '--required-check',
          'Contracts (macos-latest, Node 24)@15368',
          '--required-check',
          'Contracts (ubuntu-latest, Node 22)@15368',
        ]);
        let weakened = false;
        try {
          releaseBasePolicyArgs([
            '--base-branch',
            'main',
            '--required-check',
            'Contracts (ubuntu-latest, Node 22)@15368',
          ]);
        } catch {
          weakened = true;
        }
        return {
          exact: exact === RELEASE_BASE_POLICY,
          weakened,
        };
      },
      expected: { exact: true, weakened: true },
    },
  ];
  for (const fixture of helperCases) {
    const actual = await fixture.actual();
    const passed = JSON.stringify(actual) === JSON.stringify(fixture.expected);
    process.stdout.write(`${passed ? 'ok' : 'not ok'} - ${fixture.name}\n`);
    if (!passed) {
      process.stdout.write(`  expected: ${JSON.stringify(fixture.expected)}\n`);
      process.stdout.write(`  actual:   ${JSON.stringify(actual)}\n`);
      failed += 1;
    }
  }
  const total = cases.length + helperCases.length;
  process.stdout.write(`${total - failed}/${total} release verifier fixtures passed\n`);
  return failed === 0 ? 0 : 1;
}

function readText(root, path) {
  try {
    return readFileSync(resolve(root, path), 'utf8');
  } catch {
    return undefined;
  }
}

function loadRepository(root) {
  const portabilityPaths = [
    'docs/opencode-smoke.md',
    'skills/setup/SKILL.md',
    'skills/dev/SKILL.md',
    'skills/pitcrew/SKILL.md',
    'templates/STATE.template.md',
  ];
  return {
    VERSION: readText(root, 'VERSION'),
    README: readText(root, 'README.md'),
    claudeManifest: readText(root, '.claude-plugin/plugin.json'),
    codexManifest: readText(root, '.codex-plugin/plugin.json'),
    agentsMarketplace: readText(root, '.agents/plugins/marketplace.json'),
    claudeMarketplace: readText(root, '.claude-plugin/marketplace.json'),
    changelog: readText(root, 'CHANGELOG.md'),
    setupSkill: readText(root, 'skills/setup/SKILL.md'),
    devSkill: readText(root, 'skills/dev/SKILL.md'),
    pitcrewSkill: readText(root, 'skills/pitcrew/SKILL.md'),
    configContract: readText(root, 'templates/tools/config-contract.mjs'),
    measurementDoc: readText(root, 'docs/measurement.md'),
    opencodeSmoke: readText(root, 'docs/opencode-smoke.md'),
    stateTemplate: readText(root, 'templates/STATE.template.md'),
    verifyWorkflow: readText(root, '.github/workflows/verify.yml'),
    portabilitySurfaces: Object.fromEntries(
      portabilityPaths.map((path) => [path, readText(root, path)]),
    ),
  };
}

function optionValue(args, name) {
  const positions = args
    .map((value, index) => (value === name ? index : -1))
    .filter((index) => index >= 0);
  if (positions.length === 0) return undefined;
  if (positions.length !== 1) throw new Error(`${name} must appear exactly once`);
  const value = args[positions[0] + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function optionValues(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${name} requires a value`);
    }
    values.push(value);
  }
  return values;
}

function releaseBasePolicyArgs(args) {
  const branch = optionValue(args, '--base-branch');
  const requiredChecks = optionValues(args, '--required-check')
    .map((value) => {
      const separator = value.lastIndexOf('@');
      const context = value.slice(0, separator);
      const rawIntegrationId = value.slice(separator + 1);
      const integrationId = /^[1-9][0-9]*$/u.test(rawIntegrationId)
        ? Number(rawIntegrationId)
        : null;
      return { context, integrationId };
    })
    .sort((left, right) => left.context.localeCompare(right.context));
  if (
    branch !== RELEASE_BASE_POLICY.branch
    || JSON.stringify(requiredChecks)
      !== JSON.stringify(RELEASE_BASE_POLICY.requiredChecks)
  ) {
    throw new Error(
      'release arguments must exactly match the committed configured-base policy',
    );
  }
  return RELEASE_BASE_POLICY;
}

function repositoryRoot(args) {
  const explicit = optionValue(args, '--check-root');
  const positional =
    args.length === 1 && !args[0].startsWith('-') ? args[0] : undefined;
  return resolve(explicit ?? positional ?? process.cwd());
}

function gitEnvironment() {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('GIT_')) delete environment[key];
  }
  return {
    ...environment,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
  };
}

function gitText(root, args) {
  return execFileSync('git', [
    '--no-replace-objects',
    '--no-optional-locks',
    '-C',
    root,
    ...args,
  ], {
    encoding: 'utf8',
    env: gitEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10000,
  }).trim();
}

function gitBytes(root, args, maximumBytes) {
  return execFileSync('git', [
    '--no-replace-objects',
    '--no-optional-locks',
    '-C',
    root,
    ...args,
  ], {
    encoding: 'buffer',
    env: gitEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10000,
    maxBuffer: maximumBytes + 1024,
  });
}

export function readCommittedEvidenceArtifact(root, path, maximumBytes) {
  if (
    !validEvidencePath(path, 'evidence/')
    || !Number.isSafeInteger(maximumBytes)
    || maximumBytes < 1
    || maximumBytes > MAX_SMOKE_FILE_BYTES
  ) {
    throw new Error('evidence artifact path or bound is invalid');
  }
  const repositoryRoot = realpathSync(root);
  const candidate = resolve(repositoryRoot, path);
  const confined = relative(repositoryRoot, candidate);
  if (
    confined !== path
    || confined.startsWith('..')
    || resolve(realpathSync(candidate)) !== candidate
  ) {
    throw new Error('evidence artifact escapes the repository');
  }
  const stats = lstatSync(candidate);
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || stats.size < 1
    || stats.size > maximumBytes
  ) {
    throw new Error('evidence artifact is not a bounded regular file');
  }
  const tree = gitBytes(
    repositoryRoot,
    ['ls-tree', '-z', 'HEAD', '--', path],
    4096,
  );
  const match = tree.toString('utf8').match(
    /^(100644|100755) blob ([0-9a-f]{40,64})\t([^\0]+)\0$/u,
  );
  if (!match || match[3] !== path) {
    throw new Error('evidence artifact is not a committed regular blob');
  }
  const committed = gitBytes(
    repositoryRoot,
    ['cat-file', 'blob', `HEAD:${path}`],
    maximumBytes,
  );
  const working = readFileSync(candidate);
  if (
    committed.length < 1
    || committed.length > maximumBytes
    || !working.equals(committed)
  ) {
    throw new Error('evidence artifact differs from the committed blob');
  }
  return committed;
}

export function repositorySlugFromRemote(remote) {
  if (typeof remote !== 'string') return null;
  const match = remote.trim().match(
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?$/u,
  );
  if (!match) return null;
  const repository = `${match[1]}/${match[2]}`;
  return REPOSITORY.test(repository) ? repository : null;
}

function boundRepository(root, expected) {
  const repository = repositorySlugFromRemote(
    gitText(root, ['remote', 'get-url', 'origin']),
  );
  if (repository === null) {
    throw new Error('origin is not one exact github.com owner/name repository');
  }
  if (expected !== undefined && repository !== expected) {
    throw new Error('--repository does not match the current origin');
  }
  return repository;
}

function readReleaseTagBinding(root, version, tagName, mainRef) {
  const tagRef = `refs/tags/${tagName}`;
  const headOid = gitText(root, ['rev-parse', 'HEAD^{commit}']);
  const tagCommitOid = gitText(root, ['rev-parse', `${tagRef}^{commit}`]);
  const tagObjectType = gitText(root, ['cat-file', '-t', tagRef]);
  const ancestry = spawnSync(
    'git',
    [
      '--no-replace-objects',
      '--no-optional-locks',
      '-C',
      root,
      'merge-base',
      '--is-ancestor',
      tagCommitOid,
      mainRef,
    ],
    {
      encoding: 'utf8',
      env: gitEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
    },
  );
  if (ancestry.status !== 0 && ancestry.status !== 1) {
    throw new Error(
      `cannot prove main ancestry: ${ancestry.stderr.trim() || 'git failed'}`,
    );
  }
  return {
    version,
    tagName,
    tagObjectType,
    mainRef,
    headOid,
    tagCommitOid,
    mainContainsTag: ancestry.status === 0,
    ...(process.env.GITHUB_REF === undefined
      ? {}
      : { currentRef: process.env.GITHUB_REF }),
    ...(process.env.GITHUB_REF_NAME === undefined
      ? {}
      : { currentRefName: process.env.GITHUB_REF_NAME }),
    ...(process.env.GITHUB_REF_TYPE === undefined
      ? {}
      : { currentRefType: process.env.GITHUB_REF_TYPE }),
  };
}

async function githubJson(path, token) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'User-Agent': 'autoloop-release-verifier',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} for ${path}`);
  }
  return response.json();
}

async function readRepositoryRulesets(repository, token) {
  if (!REPOSITORY.test(repository)) {
    throw new Error('--repository must be owner/name');
  }
  const summaries = [];
  const ids = new Set();
  for (let page = 1; page <= 11; page += 1) {
    const values = await githubJson(
      `/repos/${repository}/rulesets?includes_parents=true&per_page=100&page=${page}`,
      token,
    );
    if (!Array.isArray(values)) {
      throw new Error('GitHub ruleset list is not an array');
    }
    if (summaries.length + values.length > MAX_RULESETS) {
      throw new Error(`GitHub ruleset list exceeds ${MAX_RULESETS} entries`);
    }
    for (const value of values) {
      if (!Number.isSafeInteger(value?.id) || ids.has(value.id)) {
        throw new Error('GitHub ruleset list has a missing or duplicate id');
      }
      ids.add(value.id);
      summaries.push(value);
    }
    if (values.length < 100) break;
  }
  const details = [];
  for (let index = 0; index < summaries.length; index += 10) {
    const batch = summaries.slice(index, index + 10);
    const values = await Promise.all(
      batch.map((summary) =>
        githubJson(
          `/repos/${repository}/rulesets/${summary.id}?includes_parents=true`,
          token,
        )),
    );
    if (values.some((value, offset) => value?.id !== batch[offset].id)) {
      throw new Error('GitHub ruleset detail identity changed');
    }
    details.push(...values);
  }
  return details;
}

export async function readImmutableReleases(
  repository,
  token,
  request = githubJson,
) {
  if (!REPOSITORY.test(repository)) {
    throw new Error('--repository must be owner/name');
  }
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error(
      'immutable releases: authenticated GitHub API token is required '
      + '(Administration repository read)',
    );
  }
  return request(`/repos/${repository}/immutable-releases`, token);
}

export async function verifyLiveReleaseControls(input, adapters = {}) {
  const readRulesets = adapters.readRulesets ?? readRepositoryRulesets;
  const readImmutable = adapters.readImmutable ?? readImmutableReleases;
  const [rulesets, immutable] = await Promise.all([
    readRulesets(input.repository, input.token),
    readImmutable(input.repository, input.token),
  ]);
  return [
    ...verifyReleaseTagRulesets(rulesets),
    ...verifyConfiguredBaseRulesets(
      rulesets,
      input.basePolicy ?? RELEASE_BASE_POLICY,
    ),
    ...verifyImmutableReleases(immutable, {
      requireOwnerEnforcement: input.requireOwnerEnforcement === true,
    }),
  ];
}

function githubToken() {
  const configured =
    process.env.AUTOLOOP_RELEASE_POLICY_TOKEN
    || process.env.GH_TOKEN
    || process.env.GITHUB_TOKEN;
  if (configured) return configured;
  try {
    return execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10000,
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function requiredGithubToken() {
  const token = githubToken();
  if (!token) {
    throw new Error(
      'authenticated GitHub API token is unavailable; set '
      + 'AUTOLOOP_RELEASE_POLICY_TOKEN with Administration repository read '
      + 'and ruleset bypass visibility',
    );
  }
  return token;
}

async function releaseMode(args) {
  const root = repositoryRoot(args);
  const files = loadRepository(root);
  const notes = [];
  const errors = verifyRelease(files, {
    root,
    note: (text) => notes.push(text),
  });
  const version = files.VERSION?.trim() ?? '';
  const tagName = optionValue(args, '--tag');
  const mainRef = optionValue(args, '--main-ref');
  let basePolicy;
  try {
    basePolicy = releaseBasePolicyArgs(args);
  } catch (error) {
    errors.push(`release base policy: ${error.message}`);
  }
  if (!tagName) errors.push('release mode: --tag is required');
  if (!mainRef) errors.push('release mode: --main-ref is required');
  if (tagName && mainRef) {
    try {
      errors.push(...verifyReleaseTagBinding(
        readReleaseTagBinding(root, version, tagName, mainRef),
      ));
    } catch (error) {
      errors.push(`release tag binding: ${error.message}`);
    }
  }
  let repository;
  try {
    repository = boundRepository(root, optionValue(args, '--repository'));
    errors.push(...await verifyLiveReleaseControls({
      repository,
      token: requiredGithubToken(),
      basePolicy: basePolicy ?? RELEASE_BASE_POLICY,
      requireOwnerEnforcement: args.includes('--require-owner-enforcement'),
    }));
  } catch (error) {
    // Reading rulesets, bypass actors, and the immutable-release setting are
    // Administration reads, and `administration` is not a permission a workflow
    // can grant its own token. Where no credential can see them, say so instead
    // of claiming the controls are absent: unreadable is not the same evidence
    // as non-compliant, and a returned violation above is still a hard failure.
    if (args.includes('--allow-unverified-live-controls')) {
      notes.push(`live release controls are unverified: ${error.message}`);
    } else {
      errors.push(`live release controls: ${error.message}`);
    }
  }
  if (errors.length > 0) {
    process.stderr.write(
      `release verification failed:\n${errors.map((error) => `- ${error}`).join('\n')}\n`,
    );
    return 1;
  }
  for (const text of notes) process.stdout.write(`note: ${text}\n`);
  process.stdout.write(
    `release verification passed (v${version}; annotated tag on main; `
    + `${repository}; non-bypassable configured base and tags; `
    + 'immutable releases)\n',
  );
  return 0;
}

async function basePolicyMode(args) {
  const root = repositoryRoot(args);
  let repository;
  try {
    const basePolicy = releaseBasePolicyArgs(args);
    repository = boundRepository(root, optionValue(args, '--repository'));
    const rulesets = await readRepositoryRulesets(
      repository,
      requiredGithubToken(),
    );
    const errors = verifyConfiguredBaseRulesets(rulesets, basePolicy);
    if (errors.length > 0) {
      process.stderr.write(
        `base policy verification failed:\n`
        + `${errors.map((error) => `- ${error}`).join('\n')}\n`,
      );
      return 1;
    }
  } catch (error) {
    process.stderr.write(`base policy verification failed: ${error.message}\n`);
    return 1;
  }
  process.stdout.write(
    `base policy verification passed (${repository}; `
    + `${RELEASE_BASE_POLICY.branch}; non-bypassable trusted checks)\n`,
  );
  return 0;
}

async function tagPolicyMode(args) {
  const root = repositoryRoot(args);
  const expectedRepository = optionValue(args, '--repository');
  let repository;
  try {
    repository = boundRepository(root, expectedRepository);
    const rulesets = await readRepositoryRulesets(
      repository,
      requiredGithubToken(),
    );
    const errors = verifyReleaseTagRulesets(rulesets);
    if (errors.length > 0) {
      process.stderr.write(
        `tag policy verification failed:\n${errors.map((error) => `- ${error}`).join('\n')}\n`,
      );
      return 1;
    }
  } catch (error) {
    process.stderr.write(`tag policy verification failed: ${error.message}\n`);
    return 1;
  }
  process.stdout.write(
    `tag policy verification passed (${repository}; non-bypassable v* controls)\n`,
  );
  return 0;
}

async function immutableReleasesMode(args) {
  const root = repositoryRoot(args);
  let repository;
  try {
    repository = boundRepository(root, optionValue(args, '--repository'));
    const settings = await readImmutableReleases(
      repository,
      requiredGithubToken(),
    );
    const errors = verifyImmutableReleases(settings, {
      requireOwnerEnforcement: args.includes('--require-owner-enforcement'),
    });
    if (errors.length > 0) {
      process.stderr.write(
        `immutable release verification failed:\n`
        + `${errors.map((error) => `- ${error}`).join('\n')}\n`,
      );
      return 1;
    }
  } catch (error) {
    process.stderr.write(
      `immutable release verification failed: ${error.message}\n`,
    );
    return 1;
  }
  process.stdout.write(
    `immutable release verification passed (${repository}; enabled`
    + `${args.includes('--require-owner-enforcement') ? '; owner-enforced' : ''})\n`,
  );
  return 0;
}

async function main(args) {
  if (args.includes('--self-test')) return selfTest();
  if (args[0] === '--fingerprint-stdin') {
    process.stdout.write(`${fingerprintBytes(readFileSync(0))}\n`);
    return 0;
  }
  if (args[0] === '--list-continuation-states') {
    const directory = args[1];
    if (!directory || args.length !== 2) {
      process.stderr.write('--list-continuation-states requires one directory\n');
      return 2;
    }
    process.stdout.write(`${listContinuationStates(directory).join('\n')}\n`);
    return 0;
  }
  if (args[0] === '--sort-versions') {
    const versions = sortStableVersions(readFileSync(0, 'utf8'));
    if (versions.length === 0) {
      process.stderr.write('release verification failed: stdin contained no stable semantic versions\n');
      return 1;
    }
    process.stdout.write(`${versions.join('\n')}\n`);
    return 0;
  }
  if (args[0] === '--compare-version') {
    try {
      process.stdout.write(`${compareStableVersions(args[1], args[2])}\n`);
      return 0;
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
  }
  if (args.includes('--release-mode')) return releaseMode(args);
  if (args.includes('--check-base-policy')) return basePolicyMode(args);
  if (args.includes('--check-tag-policy')) return tagPolicyMode(args);
  if (args.includes('--check-immutable-releases')) {
    return immutableReleasesMode(args);
  }
  const root = repositoryRoot(args);
  const files = loadRepository(root);
  const notes = [];
  const errors = verifyRelease(files, {
    root,
    note: (text) => notes.push(text),
  });
  if (errors.length > 0) {
    process.stderr.write(`release verification failed:\n${errors.map((error) => `- ${error}`).join('\n')}\n`);
    return 1;
  }
  for (const text of notes) process.stdout.write(`note: ${text}\n`);
  process.stdout.write(`release verification passed (v${files.VERSION.trim()})\n`);
  return 0;
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`release verification failed: ${error.message}\n`);
      process.exitCode = 2;
    });
}
