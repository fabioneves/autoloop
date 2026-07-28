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
const MAX_SMOKE_MANIFEST_BYTES = 256 * 1024;
const MAX_SMOKE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SMOKE_TOTAL_BYTES = 32 * 1024 * 1024;
const SMOKE_EVIDENCE_KIND = 'autoloop-opencode-live-smoke-evidence';
const SMOKE_EVIDENCE_CHECK_COUNT = 7;
const SMOKE_EVIDENCE_ROLES = Object.freeze(
  Array.from(
    { length: SMOKE_EVIDENCE_CHECK_COUNT },
    (unused, index) => `check-${String(index + 1).padStart(2, '0')}-stream`,
  ),
);
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

// prime.mjs declares the checkpoint-endpoint manifest's autoloopVersion; a
// stale literal there silently fragments measurement cohorts, so releases must
// keep it synchronized like every other version literal.
function requirePrimeVersion(text, version, errors) {
  const matches = typeof text === 'string'
    ? [...text.matchAll(/^const AUTOLOOP_VERSION = '([^']+)';$/gmu)]
    : [];
  if (matches.length !== 1 || matches[0][1] !== version) {
    errors.push(
      `templates/tools/prime.mjs: expected exactly one AUTOLOOP_VERSION literal equal to ${version}`,
    );
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
    || manifest.checks.length !== SMOKE_EVIDENCE_CHECK_COUNT
    || manifest.checks.some((check, index) => check !== index + 1)
    || !Array.isArray(manifest.files)
    || manifest.files.length !== SMOKE_EVIDENCE_ROLES.length
  ) {
    evidenceFailure(
      errors,
      `manifest identity or checks 1-${SMOKE_EVIDENCE_CHECK_COUNT} are incomplete`,
    );
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
      + 'opencode=([^;]+); checks=1-7; '
      + 'sha256=([0-9a-f]{64}); location=([^\\s]+)$',
      'gmu',
    ))]
    : [];
  // An untested declaration states that the live checks were deliberately
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

// The requirements below describe the release-verify invocation, so they are
// counted inside it rather than across the whole workflow. Counting file-wide
// meant no other step could ever take `--repository "$GITHUB_REPOSITORY"` —
// adding the api-shape probe tripped a rule that had nothing to say about it.
// A step ends at the next `- name:` at the same indentation.
export function releaseVerifyStep(text) {
  if (typeof text !== 'string') return '';
  const anchor = text.indexOf('release-verify.mjs');
  if (anchor === -1) return '';
  const start = text.lastIndexOf('\n      - name:', anchor);
  const rest = text.slice(anchor);
  const end = rest.search(/\n {6}- name:/u);
  return text.slice(start === -1 ? 0 : start, end === -1 ? text.length : anchor + end);
}

function requireReleaseWorkflow(workflow, errors) {
  const text = releaseVerifyStep(workflow);
  const requirements = [
    ['--release-mode', '--release-mode release gate'],
    [
      '--repository "$GITHUB_REPOSITORY"',
      'checkout-bound repository argument',
    ],
    ['--tag "$GITHUB_REF_NAME"', 'tag-bound release argument'],
    [
      '--main-ref refs/remotes/origin/main',
      'origin/main ancestry argument',
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
  requirePrimeVersion(files.primeTool, version, errors);
  requireReleaseReference(
    files.README,
    'README.md',
    `v${version} dispatch-surface release reference`,
    `v${version} dispatches every role through one call:`,
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
    // Schema-only on purpose: STATE prose is vendored into every configured
    // repository, and a plugin-version literal there turns each patch release
    // into per-repository prose drift.
    requireReleaseReference(
      files.stateTemplate,
      'templates/STATE.template.md',
      `schema ${configVersion} reference`,
      `the current schema is \`${configVersion}\`.`,
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
    checks: Array.from(
      { length: SMOKE_EVIDENCE_CHECK_COUNT },
      (unused, index) => index + 1,
    ),
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
      `v${version} dispatches every role through one call:`,
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
    primeTool: `const AUTOLOOP_VERSION = '${version}';\n`,
    opencodeSmoke:
      `- v${version} live smoke evidence: date=2026-07-25; `
      + `opencode=1.18.4; checks=1-7; sha256=${evidence.sha256}; `
      + `location=${evidence.location}\n`,
    evidenceArtifacts: evidence.evidenceArtifacts,
    stateTemplate: 'the current schema is `0.25.0`.\n',
    // Shaped like the real workflow, because the release requirements are
    // counted inside the release-verify step rather than across the file.
    verifyWorkflow: [
      '      - name: Verify release tag',
      '        run: >-',
      '          node templates/tools/release-verify.mjs',
      '          --release-mode',
      '          --check-root .',
      '          --repository "$GITHUB_REPOSITORY"',
      '          --tag "$GITHUB_REF_NAME"',
      '          --main-ref refs/remotes/origin/main',
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
      // 2026-07-28: counting these literals file-wide meant no other step
      // could ever take the repository name. Adding the api-shape probe --
      // which needs exactly that -- failed a release gate with nothing to say
      // about it, and the tempting "fix" was to spell the flag differently.
      name: 'another step may bind the repository without tripping the gate',
      files: (() => {
        const files = fixtureFiles();
        return {
          ...files,
          verifyWorkflow: `${files.verifyWorkflow}`
            + '      - name: Verify GitHub API shape\n'
            + '        run: >-\n'
            + '          node templates/tools/api-shape.mjs\n'
            + '          --repository "$GITHUB_REPOSITORY"\n',
        };
      })(),
      expected: [],
    },
    {
      name: 'rejects a release-verify step missing its tag argument',
      files: {
        ...fixtureFiles(),
        verifyWorkflow: [
          '      - name: Verify release tag',
          '        run: >-',
          '          node templates/tools/release-verify.mjs',
          '          --release-mode',
          '          --repository "$GITHUB_REPOSITORY"',
          '          --main-ref refs/remotes/origin/main',
          '',
        ].join('\n'),
      },
      expected: [
        '.github/workflows/verify.yml: expected exactly one tag-bound release argument',
      ],
    },
    {
      name: 'rejects a workflow with no release-verify step at all',
      files: {
        ...fixtureFiles(),
        verifyWorkflow: '      - name: Verify contracts\n        run: node x.mjs\n',
      },
      expected: [
        '.github/workflows/verify.yml: expected exactly one --release-mode release gate',
        '.github/workflows/verify.yml: expected exactly one checkout-bound repository argument',
        '.github/workflows/verify.yml: expected exactly one tag-bound release argument',
        '.github/workflows/verify.yml: expected exactly one origin/main ancestry argument',
      ],
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
          'v0.40.0 dispatches every role through one call:',
          'v0.40.0 uses schema `0.25.0`.',
          '',
        ].join('\n'),
        opencodeSmoke:
          `- v0.40.0 live smoke evidence: date=2026-07-25; `
          + `opencode=1.18.4; checks=1-7; sha256=${'a'.repeat(64)}; `
          + 'location=evidence/opencode-v0.40.0.tar\n',
        stateTemplate: 'the current schema is `0.25.0`.\n',
      },
      expected: [
        'README.md: expected exactly one v0.40.1 dispatch-surface release reference',
        'docs/opencode-smoke.md: expected exactly one complete v0.40.1 live smoke evidence record',
        'README.md: expected exactly one v0.40.1/schema 0.25.0 reference',
      ],
    },
    {
      name: 'rejects a stale prime version literal',
      files: {
        ...fixtureFiles(),
        primeTool: "const AUTOLOOP_VERSION = '0.39.9';\n",
      },
      expected: [
        'templates/tools/prime.mjs: expected exactly one AUTOLOOP_VERSION literal equal to 0.40.0',
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
        'templates/STATE.template.md: expected exactly one schema 0.26.0 reference',
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
          + 'opencode=1.18.4; checks=1-7; sha256=pending; location=pending\n',
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
        'docs/opencode-smoke.md: live smoke evidence artifact manifest identity or checks 1-7 are incomplete',
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
      name: 'requires tag CI to run the bound release gate',
      files: {
        ...fixtureFiles(),
        verifyWorkflow: [
          '      - name: Verify release tag',
          '        run: >-',
          '          node templates/tools/release-verify.mjs',
          '          --release-mode',
          '          --repository "$GITHUB_REPOSITORY"',
          '',
        ].join('\n'),
      },
      expected: [
        '.github/workflows/verify.yml: expected exactly one tag-bound release argument',
        '.github/workflows/verify.yml: expected exactly one origin/main ancestry argument',
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
    primeTool: readText(root, 'templates/tools/prime.mjs'),
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

// Release mode verifies the static release contract only: synchronized
// version literals and manifests, the workflow shape, the annotated-tag
// binding proved from local git objects, and the checkout's origin identity.
// Branch, tag, and release protection live in the repository's GitHub
// configuration and are the maintainer's responsibility; this gate makes no
// live API reads and no claims about server-side enforcement.
function releaseMode(args) {
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
  } catch (error) {
    errors.push(`release repository binding: ${error.message}`);
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
    + `${repository})\n`,
  );
  return 0;
}

async function main(args) {
  if (args.includes('--self-test')) return selfTest();
  if (args[0] === '--fingerprint-stdin') {
    process.stdout.write(`${fingerprintBytes(readFileSync(0))}\n`);
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
