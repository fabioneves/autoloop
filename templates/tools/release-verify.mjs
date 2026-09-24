#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  readFileSync,
  realpathSync,
} from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const STABLE_SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const OID = /^[0-9a-f]{40,64}$/u;
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

// Accepts bare names AND path lines: `ls -d <cache>/*/` emits
// `/…/autoloop/0.49.16/`, and silently dropping those made the documented
// "feed it plain ls output" advice a trap — every full-path line vanished, so a
// live session's instinct to add `basename` was answering a REAL hazard, with
// the one vehicle (`xargs`) the guard refuses. The tool takes the basename
// itself; version-shaped lines are kept wherever they sat in a path.
export function sortStableVersions(text) {
  return text
    .split(/\r?\n/u)
    .map((line) => {
      const trimmed = line.trim().replace(/\/+$/u, '');
      const slash = trimmed.lastIndexOf('/');
      return slash === -1 ? trimmed : trimmed.slice(slash + 1);
    })
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
  readJsonDocument(files.claudeMarketplace, '.claude-plugin/marketplace.json', errors);
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

function fixtureFiles(version = '0.40.0') {
  return {
    VERSION: `${version}\n`,
    README: [
      `<img alt="release v${version}" src="https://img.shields.io/badge/release-v${version}-8b5cf6?style=flat-square">`,
      `v${version} dispatches every role through one call:`,
      `v${version} uses schema \`0.25.0\`.`,
      '',
    ].join('\n'),
    claudeManifest: JSON.stringify({ name: 'autoloop', version }),
    claudeMarketplace: JSON.stringify({ name: 'autoloop', plugins: [] }),
    changelog: `# Changelog\n\n## [${version}] - 2026-07-24\n`,
    setupSkill: `∞ setup · v${version} · starting\n`,
    devSkill: `∞ dev · v${version} · starting\n`,
    pitcrewSkill: `∞ pitcrew · v${version} · starting\n`,
    configContract: "export const CONFIG_VERSION = '0.25.0';\n",
    primeTool: `const AUTOLOOP_VERSION = '${version}';\n`,
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
        claudeManifest: JSON.stringify({ name: 'autoloop', version: '0.39.9' }),
      },
      expected: ['.claude-plugin/plugin.json: version must equal 0.40.0'],
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
        stateTemplate: 'the current schema is `0.25.0`.\n',
      },
      expected: [
        'README.md: expected exactly one v0.40.1 dispatch-surface release reference',
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
          'skills/pitcrew/SKILL.md':
            "find \"$LEASE_DIR\" -name 'state-*.json' -printf '%f\\n'\nsha256sum\n",
          'skills/setup/SKILL.md': 'sort -V',
          'skills/dev/SKILL.md': 'sha1sum',
        },
      },
      expected: [
        'skills/dev/SKILL.md: use a portable Node fingerprint instead of sha1sum',
        'skills/pitcrew/SKILL.md: use portable file listing instead of find -printf',
        'skills/pitcrew/SKILL.md: use a portable Node fingerprint instead of sha256sum',
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
    const actual = verifyRelease(fixture.files, fixture.options);
    const passed = JSON.stringify(actual) === JSON.stringify(fixture.expected);
    process.stdout.write(`${passed ? 'ok' : 'not ok'} - ${fixture.name}\n`);
    if (!passed) {
      process.stdout.write(
        `  expected: ${JSON.stringify(fixture.expected)}\n`,
      );
      process.stdout.write(
        `  actual:   ${JSON.stringify(actual)}\n`,
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
      // 2026-07-28: `ls -d <cache>/*/` emits full paths with trailing slashes,
      // and dropping them silently made "feed it plain ls output" a trap — a
      // live setup reached for `xargs -n1 basename` (refused) because its
      // instinct about the hazard was right.
      name: 'takes the basename of path lines instead of dropping them',
      actual: () => sortStableVersions('/a/b/0.49.16/\n0.49.17\n/x/0.9.2\nnot-a-version\n'),
      expected: ['0.9.2', '0.49.16', '0.49.17'],
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
    'skills/setup/SKILL.md',
    'skills/dev/SKILL.md',
    'skills/pitcrew/SKILL.md',
    'templates/STATE.template.md',
  ];
  return {
    VERSION: readText(root, 'VERSION'),
    README: readText(root, 'README.md'),
    claudeManifest: readText(root, '.claude-plugin/plugin.json'),
    claudeMarketplace: readText(root, '.claude-plugin/marketplace.json'),
    changelog: readText(root, 'CHANGELOG.md'),
    setupSkill: readText(root, 'skills/setup/SKILL.md'),
    devSkill: readText(root, 'skills/dev/SKILL.md'),
    pitcrewSkill: readText(root, 'skills/pitcrew/SKILL.md'),
    configContract: readText(root, 'templates/tools/config-contract.mjs'),
    primeTool: readText(root, 'templates/tools/prime.mjs'),
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
  const errors = verifyRelease(files, { root });
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
  const errors = verifyRelease(files, { root });
  if (errors.length > 0) {
    process.stderr.write(`release verification failed:\n${errors.map((error) => `- ${error}`).join('\n')}\n`);
    return 1;
  }
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
