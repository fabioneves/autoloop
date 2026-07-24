#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const STABLE_SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
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

function countLiteral(text, literal) {
  if (typeof text !== 'string') return 0;
  return text.split(literal).length - 1;
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

export function verifyRelease(files) {
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

  for (const [path, text] of Object.entries(files.portabilitySurfaces ?? {}).sort()) {
    if (/\bsort[ \t]+-V\b/u.test(text)) {
      errors.push(`${path}: use a portable Node version comparator instead of sort -V`);
    }
    if (/\bsha1sum\b/u.test(text)) {
      errors.push(`${path}: use a portable Node fingerprint instead of sha1sum`);
    }
  }

  return errors;
}

function fixtureFiles(version = '0.40.0') {
  return {
    VERSION: `${version}\n`,
    README: `<img alt="release v${version}" src="https://img.shields.io/badge/release-v${version}-8b5cf6?style=flat-square">\n`,
    claudeManifest: JSON.stringify({ name: 'autoloop', version }),
    codexManifest: JSON.stringify({ name: 'autoloop', version }),
    agentsMarketplace: JSON.stringify({ name: 'autoloop', plugins: [] }),
    claudeMarketplace: JSON.stringify({ name: 'autoloop', plugins: [] }),
    changelog: `# Changelog\n\n## [${version}] - 2026-07-24\n`,
    setupSkill: `∞ setup · v${version} · starting\n`,
    devSkill: `∞ dev · v${version} · starting\n`,
    pitcrewSkill: `∞ pitcrew · v${version} · starting\n`,
    portabilitySurfaces: {
      'skills/setup/SKILL.md': 'portable release selection\n',
      'skills/dev/SKILL.md': 'portable fingerprint helper\n',
      'templates/STATE.template.md': 'portable fingerprint helper\n',
    },
  };
}

function selfTest() {
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
      name: 'rejects non-portable release and fingerprint helpers',
      files: {
        ...fixtureFiles(),
        portabilitySurfaces: {
          'skills/setup/SKILL.md': 'sort -V',
          'skills/dev/SKILL.md': 'sha1sum',
        },
      },
      expected: [
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
  ];

  let failed = 0;
  for (const fixture of cases) {
    const actual = verifyRelease(fixture.files);
    const passed = JSON.stringify(actual) === JSON.stringify(fixture.expected);
    process.stdout.write(`${passed ? 'ok' : 'not ok'} - ${fixture.name}\n`);
    if (!passed) {
      process.stdout.write(`  expected: ${JSON.stringify(fixture.expected)}\n`);
      process.stdout.write(`  actual:   ${JSON.stringify(actual)}\n`);
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
  ];
  for (const fixture of helperCases) {
    const actual = fixture.actual();
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
    codexManifest: readText(root, '.codex-plugin/plugin.json'),
    agentsMarketplace: readText(root, '.agents/plugins/marketplace.json'),
    claudeMarketplace: readText(root, '.claude-plugin/marketplace.json'),
    changelog: readText(root, 'CHANGELOG.md'),
    setupSkill: readText(root, 'skills/setup/SKILL.md'),
    devSkill: readText(root, 'skills/dev/SKILL.md'),
    pitcrewSkill: readText(root, 'skills/pitcrew/SKILL.md'),
    portabilitySurfaces: Object.fromEntries(
      portabilityPaths.map((path) => [path, readText(root, path)]),
    ),
  };
}

function main(args) {
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
  const root = args.find((arg) => !arg.startsWith('-')) ?? process.cwd();
  const files = loadRepository(root);
  const errors = verifyRelease(files);
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

if (isMain) process.exitCode = main(process.argv.slice(2));
