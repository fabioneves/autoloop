#!/usr/bin/env node

import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FORWARD_ARTIFACTS = Object.freeze([
  'README.md',
  'skills/setup/SKILL.md',
  'skills/dev/SKILL.md',
  'skills/pitcrew/SKILL.md',
  'templates/STATE.template.md',
  'templates/LOOP.template.md',
  'templates/ARCH.template.md',
  'docs/opencode-smoke.md',
]);

const STALE_ROUTE_PATTERNS = Object.freeze([
  {
    code: 'PERSISTED_HOST_AUTHORITY',
    pattern: /\bcfg\.runtime\.supportedHosts\b/gu,
    message: 'runtime.supportedHosts cannot select or authorize a route',
  },
  {
    code: 'PERSISTED_PROFILE_AUTHORITY',
    pattern: /\bcfg\.engine\.profile\b/gu,
    message: 'engine.profile cannot select or authorize a route',
  },
  {
    code: 'LEGACY_HOST_VALIDATION',
    pattern: /\bconfig-contract\.mjs\s+--host\b/gu,
    message: 'config validation cannot take host routing intent',
  },
  {
    code: 'PROFILE_ROUTE_PROSE',
    pattern: /\bengine profile\s+(?:is|must|selects|controls|determines|requires)\b/giu,
    message: 'engine-profile routing prose is retired',
  },
]);

function lineNumber(text, index) {
  return text.slice(0, index).split('\n').length;
}

export function lintRoutingText(text, path = '<text>') {
  const findings = [];
  for (const rule of STALE_ROUTE_PATTERNS) {
    for (const match of String(text).matchAll(rule.pattern)) {
      findings.push({
        path,
        line: lineNumber(String(text), match.index),
        code: rule.code,
        message: rule.message,
      });
    }
  }
  return findings;
}

export function lintClaimRegexDefinitions(files) {
  const findings = [];
  for (const [path, text] of Object.entries(files)) {
    if (path.endsWith('/claim-contract.mjs') || path === 'claim-contract.mjs') continue;
    const pattern = /\b(?:const|let|var)\s+CLOSES_RE\b/gu;
    for (const match of String(text).matchAll(pattern)) {
      findings.push({
        path,
        line: lineNumber(String(text), match.index),
        code: 'DUPLICATE_CLAIM_GRAMMAR',
        message: 'CLOSES_RE must be defined only by claim-contract.mjs',
      });
    }
  }
  return findings;
}

function lintRoot(root) {
  const findings = [];
  for (const relativePath of FORWARD_ARTIFACTS) {
    const path = resolve(root, relativePath);
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      findings.push({
        path: relativePath,
        line: 1,
        code: 'MISSING_FORWARD_ARTIFACT',
        message: error.message,
      });
      continue;
    }
    findings.push(...lintRoutingText(text, relativePath));
  }

  const toolFiles = {};
  const claimConsumers = [
    'templates/tools/claim-contract.mjs',
    'templates/tools/scan.mjs',
    'templates/tools/loop-scope.mjs',
    'templates/tools/stats.mjs',
    'templates/tools/writeback-check.mjs',
    'templates/tools/auto-merge.reference.mjs',
  ];
  for (const relativePath of claimConsumers) {
    try {
      toolFiles[relativePath] = readFileSync(resolve(root, relativePath), 'utf8');
    } catch (error) {
      findings.push({
        path: relativePath,
        line: 1,
        code: 'MISSING_CLAIM_CONSUMER',
        message: error.message,
      });
    }
  }
  findings.push(...lintClaimRegexDefinitions(toolFiles));
  return findings;
}

function selfTest() {
  const clean = lintRoutingText(
    'Migration removes runtime.supportedHosts and engine.profile; RuntimeContract owns routing.',
  );
  const stale = lintRoutingText(
    'Read cfg.runtime.supportedHosts. The engine profile selects the reviewer.',
    'dev.md',
  );
  const claim = lintClaimRegexDefinitions({
    'claim-contract.mjs': 'export const CLOSES_RE = /x/;',
    'scan.mjs': 'const CLOSES_RE = /y/;',
  });
  const cases = [
    ['migration prose is allowed', clean.length === 0],
    [
      'operational host/profile prose is rejected',
      stale.length === 2
        && stale[0].code === 'PERSISTED_HOST_AUTHORITY'
        && stale[1].code === 'PROFILE_ROUTE_PROSE',
    ],
    [
      'claim grammar has one owner',
      claim.length === 1 && claim[0].path === 'scan.mjs',
    ],
  ];
  const failures = cases.filter(([, passed]) => !passed);
  for (const [name] of failures) console.error(`FAIL ${name}`);
  console.log(
    failures.length === 0
      ? `self-test OK (${cases.length} cases)`
      : `self-test FAILED (${failures.length}/${cases.length})`,
  );
  return failures.length === 0;
}

function parseArgs(args) {
  if (args.length === 1 && args[0] === '--self-test') {
    return { mode: 'self-test', root: null, error: null };
  }
  if (args.length === 2 && args[0] === '--check-root' && args[1]) {
    return { mode: 'check', root: args[1], error: null };
  }
  return {
    mode: null,
    root: null,
    error: 'expected --check-root <plugin root> or --self-test',
  };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(`contract-lint: ${parsed.error}`);
    process.exit(2);
  }
  if (parsed.mode === 'self-test') process.exit(selfTest() ? 0 : 1);
  const findings = lintRoot(parsed.root);
  for (const finding of findings) {
    console.error(
      `${finding.path}:${finding.line}: ${finding.code}: ${finding.message}`,
    );
  }
  if (findings.length > 0) {
    console.error(`contract lint failed (${findings.length} finding(s))`);
    process.exit(1);
  }
  console.log('contract lint passed');
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) main();
