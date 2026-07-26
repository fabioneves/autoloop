#!/usr/bin/env node

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNTIME_ROUTING_CONSUMERS = Object.freeze([
  'runtime-contract.mjs',
  'run-scope.mjs',
  'route-adapter-contract.mjs',
]);
const FORWARD_ARTIFACTS = Object.freeze([
  'README.md',
  'CONTRIBUTING.md',
  'skills/setup/SKILL.md',
  'skills/dev/SKILL.md',
  'skills/pitcrew/SKILL.md',
  'skills/shape/SKILL.md',
  'skills/queue-trace/SKILL.md',
  'templates/STATE.template.md',
  'templates/LOOP.template.md',
  'templates/ARCH.template.md',
  'templates/settings-hooks.template.json',
  'templates/codex-hooks.template.json',
  'templates/opencode-config.template.json',
  'templates/opencode-plugin.template.js',
  'templates/codex-reviewer-agent.template.toml',
  'templates/opencode-reviewer-agent.template.md',
  'templates/tools/label-swap-reminder.mjs',
  'templates/tools/session-preflight.sh',
  ...RUNTIME_ROUTING_CONSUMERS.map((name) => `templates/tools/${name}`),
  'docs/measurement.md',
  'docs/opencode-smoke.md',
]);
const INSTALLED_FORWARD_ARTIFACTS = Object.freeze([
  'docs/agentic/STATE.md',
  'docs/agentic/LOOP.md',
  '.claude/settings.json',
  '.codex/hooks.json',
  '.codex/config.toml',
  '.codex/agents/autoloop-reviewer.toml',
  '.opencode/agent/autoloop-reviewer.md',
  '.opencode/plugins/autoloop.js',
  '.opencode/opencode.json',
  'tools/agentic/session-preflight.sh',
  ...RUNTIME_ROUTING_CONSUMERS.map((name) => `tools/agentic/${name}`),
]);

const STALE_ROUTE_PATTERNS = Object.freeze([
  {
    code: 'UNCONDITIONAL_NON_MANUAL_REFUSAL',
    pattern:
      /\b(?:non-?manual|other than `?manual`?)\b[^.\n]{0,120}\b(?:fail(?:s|ure)?|reject\w*|refus\w*|forbid\w*)|\b(?:reject\w*|refus\w*|forbid\w*|never\s+enable\w*)\b[^.\n]{0,120}\bnon-?manual\b/giu,
    message:
      'a non-manual merge policy fails only without '
      + 'merge.unverifiedInvocationAcknowledged; state the conditional',
    exemptMatch: ({ source, index }) => {
      if (typeof source !== 'string') return false;
      const window = source.slice(Math.max(0, index - 400), index + 400);
      return window.includes('unverifiedInvocationAcknowledged')
        || /\bunacknowledged\b/iu.test(window);
    },
  },
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
    code: 'RETIRED_ROUTE_FIELD_READ',
    pattern:
      /\b(?:read|use|consult|load|derive\s+from)\s+`?(?:runtime\.supportedHosts|engine\.profile)`?\b/giu,
    message: 'retired host/profile fields cannot be read as runtime authority',
  },
  {
    code: 'RETIRED_ROUTE_FIELD_ACTION',
    pattern:
      /\b(?:runtime\.supportedHosts|engine\.profile)\b\s+(?:selects|controls|determines|chooses|routes|authorizes)\b/giu,
    message: 'retired host/profile fields cannot control runtime routing',
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
  {
    code: 'LEGACY_ADAPTER_OPTION_PATH',
    pattern: /\bengine\.(?:claude|codex|opencode)\.[A-Za-z][A-Za-z0-9]*\b/gu,
    message: 'host tuning belongs under adapterOptions, not the retired engine table',
  },
  {
    code: 'CAPABILITY_FAILURE_AS_OUTAGE',
    pattern: /\bwhen\s+`?codex exec`?\s+is\s+unavailable\b/giu,
    message: 'a missing executable is a capability failure, not a bounded-outage fallback trigger',
  },
  {
    code: 'ARCH_FRESHNESS_FIELD',
    pattern: /\bLast-verified\b/giu,
    message: 'ARCH freshness comes from Git history, not shared metadata',
  },
  {
    code: 'OPENCODE_EXTERNAL_AUTO_APPROVAL',
    pattern:
      /\bopencode run --auto(?=[^\r\n]{0,160}(?:--agent autoloop-reviewer|--format json))/giu,
    message: 'external opencode routes use --pure and omit global auto-approval',
    exemptMatch: ({ path, line }) =>
      path === 'docs/opencode-smoke.md'
      && /\bopencode run --auto \$M\b/u.test(line),
  },
]);

function lineNumber(text, index) {
  return text.slice(0, index).split('\n').length;
}

export function lintRoutingText(text, path = '<text>') {
  const source = String(text);
  const findings = [];
  for (const rule of STALE_ROUTE_PATTERNS) {
    for (const match of source.matchAll(rule.pattern)) {
      const start = source.lastIndexOf('\n', match.index - 1) + 1;
      const end = source.indexOf('\n', match.index);
      const line = source.slice(start, end === -1 ? source.length : end);
      if (rule.exemptMatch?.({ path, line, source, index: match.index })) continue;
      findings.push({
        path,
        line: lineNumber(source, match.index),
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

function lintArtifactPaths(root, relativePaths, requiredPaths = relativePaths) {
  const findings = [];
  const required = new Set(requiredPaths);
  for (const relativePath of relativePaths) {
    const path = resolve(root, relativePath);
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      if (required.has(relativePath)) {
        findings.push({
          path: relativePath,
          line: 1,
          code: 'MISSING_FORWARD_ARTIFACT',
          message: error.message,
        });
      }
      continue;
    }
    findings.push(...lintRoutingText(text, relativePath));
  }
  return findings;
}

function lintClaimConsumers(root, directory) {
  const findings = [];
  const toolFiles = {};
  const claimConsumers = [
    'claim-contract.mjs',
    'scan.mjs',
    'loop-scope.mjs',
    'stats.mjs',
    'writeback-check.mjs',
    directory === 'templates/tools'
      ? 'auto-merge.reference.mjs'
      : 'auto-merge.mjs',
  ];
  for (const name of claimConsumers) {
    const relativePath = `${directory}/${name}`;
    try {
      toolFiles[relativePath] = readFileSync(resolve(root, relativePath), 'utf8');
    } catch (error) {
      if (name.startsWith('auto-merge.')) continue;
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

function lintRoot(root) {
  return [
    ...lintArtifactPaths(root, FORWARD_ARTIFACTS),
    ...lintClaimConsumers(root, 'templates/tools'),
  ];
}

function lintInstallRoot(root) {
  return [
    ...lintArtifactPaths(
      root,
      INSTALLED_FORWARD_ARTIFACTS,
      ['docs/agentic/STATE.md', 'docs/agentic/LOOP.md'],
    ),
    ...lintClaimConsumers(root, 'tools/agentic'),
  ];
}

function installedRoutingRegression() {
  const root = mkdtempSync(join(tmpdir(), 'autoloop-contract-lint-'));
  try {
    const files = [
      'docs/agentic/STATE.md',
      'docs/agentic/LOOP.md',
      'tools/agentic/claim-contract.mjs',
      'tools/agentic/scan.mjs',
      'tools/agentic/loop-scope.mjs',
      'tools/agentic/stats.mjs',
      'tools/agentic/writeback-check.mjs',
      'tools/agentic/runtime-contract.mjs',
      'tools/agentic/run-scope.mjs',
      'tools/agentic/route-adapter-contract.mjs',
    ];
    for (const relativePath of files) {
      const path = resolve(root, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        relativePath.endsWith('runtime-contract.mjs')
          ? 'const route = cfg.runtime.supportedHosts;'
          : '',
      );
    }
    return lintInstallRoot(root).some((finding) =>
      finding.path === 'tools/agentic/runtime-contract.mjs'
      && finding.code === 'PERSISTED_HOST_AUTHORITY');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function selfTest() {
  const clean = lintRoutingText(
    'Migration removes runtime.supportedHosts and engine.profile; RuntimeContract owns routing.',
  );
  const stale = lintRoutingText(
    [
      'Read cfg.runtime.supportedHosts.',
      'The engine profile selects the reviewer.',
      'Use engine.opencode.reviewerModel.',
      'Fall back when `codex exec` is unavailable.',
      'Add Last-verified.',
      'Launch opencode run --auto --agent autoloop-reviewer --format json.',
      'Read runtime.supportedHosts.',
      'engine.profile selects the engine.',
    ].join(' '),
    'dev.md',
  );
  const claim = lintClaimRegexDefinitions({
    'claim-contract.mjs': 'export const CLOSES_RE = /x/;',
    'scan.mjs': 'const CLOSES_RE = /y/;',
  });
  const smokeExemption = lintRoutingText(
    '`opencode run --auto $M --format json "smoke"`',
    'docs/opencode-smoke.md',
  );
  const overbroadSmokeExemption = lintRoutingText(
    '`opencode run --auto --format json "production"`',
    'docs/opencode-smoke.md',
  );
  const cases = [
    ['migration prose is allowed', clean.length === 0],
    [
      'operational host/profile prose is rejected',
      stale.length === 8
        && stale[0].code === 'PERSISTED_HOST_AUTHORITY'
        && stale[1].code === 'RETIRED_ROUTE_FIELD_READ'
        && stale[2].code === 'RETIRED_ROUTE_FIELD_ACTION'
        && stale[3].code === 'PROFILE_ROUTE_PROSE'
        && stale[4].code === 'LEGACY_ADAPTER_OPTION_PATH'
        && stale[5].code === 'CAPABILITY_FAILURE_AS_OUTAGE'
        && stale[6].code === 'ARCH_FRESHNESS_FIELD'
        && stale[7].code === 'OPENCODE_EXTERNAL_AUTO_APPROVAL',
    ],
    [
      'claim grammar has one owner',
      claim.length === 1 && claim[0].path === 'scan.mjs',
    ],
    [
      'installed forward surfaces include durable state and hook injection',
      INSTALLED_FORWARD_ARTIFACTS.includes('docs/agentic/STATE.md')
        && INSTALLED_FORWARD_ARTIFACTS.includes('docs/agentic/LOOP.md')
        && INSTALLED_FORWARD_ARTIFACTS.includes(
          'tools/agentic/session-preflight.sh',
        ),
    ],
    [
      'only the explicit opencode smoke harness is exempt',
      smokeExemption.length === 0
        && overbroadSmokeExemption.length === 1,
    ],
    [
      'installed runtime consumers are linted',
      installedRoutingRegression(),
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
  if (args.length === 2 && args[0] === '--check-install-root' && args[1]) {
    return { mode: 'check-install', root: args[1], error: null };
  }
  return {
    mode: null,
    root: null,
    error:
      'expected --check-root <plugin root>, --check-install-root <repository root>, '
      + 'or --self-test',
  };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(`contract-lint: ${parsed.error}`);
    process.exit(2);
  }
  if (parsed.mode === 'self-test') process.exit(selfTest() ? 0 : 1);
  const findings = parsed.mode === 'check'
    ? lintRoot(parsed.root)
    : lintInstallRoot(parsed.root);
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
