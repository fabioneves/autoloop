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

// The tools a stale routing instruction would most plausibly land in.
const DISPATCH_CONSUMERS = Object.freeze([
  'dispatch.mjs',
  'prime.mjs',
  'review-contract.mjs',
]);
// Deleted with the broker. Naming one of these in an instruction is a dangling
// reference by construction: the file does not exist in any install.
const RETIRED_TOOLS = Object.freeze([
  'run-scope.mjs',
  'runtime-contract.mjs',
  'route-adapter-contract.mjs',
  'measurement-contract.mjs',
  'intent-contract.mjs',
  'continuation-store.mjs',
]);
// Structured CLI seams that only the broker, the measurement ledger, or the
// route catalog ever answered.
const RETIRED_FLAGS = Object.freeze([
  'attest-host-json',
  'open-json',
  'probe-json',
  'plan-json',
  'compile-json',
  'execute-json',
  'observe-json',
  'observe-measured-json',
  'bind-measurement-json',
  'bind-measurement-unit-json',
  'initialize-route-state-json',
  'refresh-route-state-json',
  'finish-json',
  'dev-json',
  'conclude-json',
  'capture-event',
  'capture-hook',
  'capture-hook-json',
  'run-operation',
  'measured',
  'check-budget-policy',
  'finalize-events',
  'export-evidence-bundle',
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
  ...DISPATCH_CONSUMERS.map((name) => `templates/tools/${name}`),
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
  ...DISPATCH_CONSUMERS.map((name) => `tools/agentic/${name}`),
]);

const STALE_ROUTE_PATTERNS = Object.freeze([
  {
    code: 'UNCONDITIONAL_NON_MANUAL_REFUSAL',
    // The refusal window crosses a single line wrap (but never a blank line), and
    // an unconditional rejection claim is also recognized by the provenance error
    // code alone, because table rows name the policy in a different cell.
    pattern:
      /\b(?:non-?manual|other than `?manual`?)\b(?:[^.\n]|\n(?!\s*\n)){0,160}\b(?:fail(?:s|ure)?|reject\w*|refus\w*|forbid\w*)|\b(?:reject\w*|refus\w*|forbid\w*|never\s+enable\w*)\b(?:[^.\n]|\n(?!\s*\n)){0,160}\bnon-?manual\b|\b(?:reject\w*|refus\w*)\b(?:[^.\n]|\n(?!\s*\n)){0,80}\bUNVERIFIABLE_INVOCATION_PROVENANCE\b/giu,
    message:
      'a non-manual merge policy fails only without '
      + 'merge.unverifiedInvocationAcknowledged; state the conditional',
    exemptMatch: ({ source, index }) => {
      if (typeof source !== 'string') return false;
      const window = source.slice(Math.max(0, index - 400), index + 400);
      return window.includes('unverifiedInvocationAcknowledged')
        || /\bunacknowledged\b/iu.test(window)
        || /\backnowledged\s+non-?manual\b/iu.test(window);
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
    message: 'the retired engine tuning table has no replacement key',
  },
  {
    code: 'RETIRED_MACHINERY_TOOL',
    pattern: new RegExp(
      `\\btools/agentic/(?:${RETIRED_TOOLS.map((name) =>
        name.replace('.', '\\.')).join('|')})`,
      'gu',
    ),
    message: 'the broker, route, and measurement tools are deleted; '
      + 'dispatch.mjs and prime.mjs are the entry points',
  },
  {
    code: 'RETIRED_MACHINERY_SEAM',
    pattern: new RegExp(`--(?:${RETIRED_FLAGS.join('|')})\\b`, 'gu'),
    message: 'the broker and measurement CLI seams are deleted',
  },
  {
    code: 'RETIRED_RUNTIME_CONTRACT',
    pattern: /\bRuntimeContract\b|\bauthority broker\b|\bcapability (?:probe|snapshot)\b|\bmeasurement ledger\b|\bmeasurement-budget-policy\b/giu,
    message: 'the RuntimeContract, its broker, capability probing, and the '
      + 'measurement ledger no longer exist',
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

// One scaffolded STATE block is the policy every repository starts from, and
// the setup skill shows it twice during the interview. 0.49.49 raised
// `reviseRoundsPerPr` to 10 in both skill examples and left `scaffold.mjs`
// writing 3, so for six releases the tool contradicted its own documentation
// and nothing said so. The literals ARE the policy; drift between them is
// silent by construction.
const SCAFFOLDED_CAP_KEYS = Object.freeze([
  'gateRetriesPerUnit',
  'reviseRoundsPerPr',
  'codeReviewRoundsPerUnit',
  'sliceMaxLines',
  'sliceMaxFiles',
]);

function capLiteralBlocks(text) {
  const blocks = [];
  for (const match of String(text).matchAll(/"?caps"?\s*:\s*\{([^{}]*)\}/gu)) {
    const caps = {};
    for (const pair of match[1].matchAll(/"?([A-Za-z]+)"?\s*:\s*(\d+)/gu)) {
      caps[pair[1]] = Number(pair[2]);
    }
    if (SCAFFOLDED_CAP_KEYS.every((key) => Object.hasOwn(caps, key))) {
      blocks.push({ caps, index: match.index });
    }
  }
  return blocks;
}

export function lintScaffoldCapDrift(files) {
  const scaffoldPath = Object.keys(files)
    .find((path) => path.endsWith('scaffold.mjs'));
  const scaffold = capLiteralBlocks(files[scaffoldPath] ?? '');
  if (scaffold.length !== 1) {
    return [{
      path: scaffoldPath ?? 'templates/tools/scaffold.mjs',
      line: 1,
      code: 'MISSING_SCAFFOLD_CAPS',
      message: 'expected exactly one complete scaffolded caps block',
    }];
  }
  const scaffolded = scaffold[0].caps;
  const findings = [];
  for (const [path, text] of Object.entries(files)) {
    if (path === scaffoldPath) continue;
    for (const block of capLiteralBlocks(text)) {
      for (const key of SCAFFOLDED_CAP_KEYS) {
        if (block.caps[key] === scaffolded[key]) continue;
        findings.push({
          path,
          line: lineNumber(String(text), block.index),
          code: 'SCAFFOLD_CAP_DRIFT',
          message: `caps.${key} is ${block.caps[key]}; `
            + `scaffold.mjs writes ${scaffolded[key]}`,
        });
      }
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

function lintCapPolicy(root) {
  const paths = ['templates/tools/scaffold.mjs', 'skills/setup/SKILL.md'];
  const files = {};
  for (const relativePath of paths) {
    try {
      files[relativePath] = readFileSync(resolve(root, relativePath), 'utf8');
    } catch (error) {
      return [{
        path: relativePath,
        line: 1,
        code: 'MISSING_FORWARD_ARTIFACT',
        message: error.message,
      }];
    }
  }
  return lintScaffoldCapDrift(files);
}

function lintRoot(root) {
  return [
    ...lintArtifactPaths(root, FORWARD_ARTIFACTS),
    ...lintClaimConsumers(root, 'templates/tools'),
    ...lintCapPolicy(root),
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
      'tools/agentic/dispatch.mjs',
      'tools/agentic/prime.mjs',
      'tools/agentic/review-contract.mjs',
    ];
    for (const relativePath of files) {
      const path = resolve(root, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        relativePath.endsWith('dispatch.mjs')
          ? 'const route = cfg.runtime.supportedHosts;'
          : '',
      );
    }
    return lintInstallRoot(root).some((finding) =>
      finding.path === 'tools/agentic/dispatch.mjs'
      && finding.code === 'PERSISTED_HOST_AUTHORITY');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function selfTest() {
  const clean = lintRoutingText(
    'Migration removes runtime.supportedHosts and engine.profile.',
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
  const scaffoldCaps = [
    'caps: {',
    '  gateRetriesPerUnit: 2,',
    '  reviseRoundsPerPr: 10,',
    '  codeReviewRoundsPerUnit: 20,',
    '  sliceMaxLines: 700,',
    '  sliceMaxFiles: 10,',
    '}',
  ].join('\n');
  const skillCaps = (reviseRounds) => [
    '"caps": {',
    '  "gateRetriesPerUnit": 2,',
    `  "reviseRoundsPerPr": ${reviseRounds},`,
    '  "codeReviewRoundsPerUnit": 20,',
    '  "sliceMaxLines": 700,',
    '  "sliceMaxFiles": 10',
    '}',
  ].join('\n');
  const capsAgree = lintScaffoldCapDrift({
    'templates/tools/scaffold.mjs': scaffoldCaps,
    'skills/setup/SKILL.md': skillCaps(10),
  });
  const capsDrifted = lintScaffoldCapDrift({
    'templates/tools/scaffold.mjs': scaffoldCaps,
    'skills/setup/SKILL.md': skillCaps(3),
  });
  const capsUnreadable = lintScaffoldCapDrift({
    'templates/tools/scaffold.mjs': 'caps: { gateRetriesPerUnit: 2 }',
    'skills/setup/SKILL.md': skillCaps(10),
  });
  const wrappedRefusal = lintRoutingText(
    '**A human merges.** v0.40 refuses\n  non-manual run open because prompt provenance is unverified.',
  );
  const unconditionalProvenanceClaim = lintRoutingText(
    '| **`auto`** | Reserved. v0.40 runtime open rejects it with `UNVERIFIABLE_INVOCATION_PROVENANCE`. |',
  );
  const conditionalRefusal = lintRoutingText(
    'Runtime refuses\n  non-manual run open without `merge.unverifiedInvocationAcknowledged: true`.',
  );
  const conditionalProvenanceClaim = lintRoutingText(
    'Run open rejects an unacknowledged non-manual policy with `UNVERIFIABLE_INVOCATION_PROVENANCE`.',
  );
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
    ['identical scaffold and skill cap literals pass', capsAgree.length === 0],
    [
      'a skill cap literal the scaffold does not write is drift',
      capsDrifted.length === 1
        && capsDrifted[0].code === 'SCAFFOLD_CAP_DRIFT'
        && capsDrifted[0].message.includes('caps.reviseRoundsPerPr is 3')
        && capsDrifted[0].message.includes('scaffold.mjs writes 10'),
    ],
    [
      'an unparseable scaffolded caps block fails rather than passing silently',
      capsUnreadable.length === 1
        && capsUnreadable[0].code === 'MISSING_SCAFFOLD_CAPS',
    ],
    [
      'a line-wrapped unconditional refusal is still rejected',
      wrappedRefusal.length === 1
        && wrappedRefusal[0].code === 'UNCONDITIONAL_NON_MANUAL_REFUSAL',
    ],
    [
      'an unconditional provenance-rejection claim is rejected without the policy noun',
      unconditionalProvenanceClaim.length === 1
        && unconditionalProvenanceClaim[0].code === 'UNCONDITIONAL_NON_MANUAL_REFUSAL',
    ],
    [
      'conditional refusal prose stays allowed across a line wrap',
      conditionalRefusal.length === 0,
    ],
    [
      'a provenance-rejection claim scoped to unacknowledged policies stays allowed',
      conditionalProvenanceClaim.length === 0,
    ],
    [
      'prose scoped to an acknowledged non-manual policy stays allowed',
      lintRoutingText(
        'Under an acknowledged non-manual policy the gate reads live protection and refuses unproved enforcement.',
      ).length === 0,
    ],
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
      'installed dispatch consumers are linted',
      installedRoutingRegression(),
    ],
    [
      'a deleted tool named in an instruction is a dangling reference',
      lintRoutingText('Run node tools/agentic/run-scope.mjs --probe-json.')
        .map(({ code }) => code).sort().join(',')
        === 'RETIRED_MACHINERY_SEAM,RETIRED_MACHINERY_TOOL',
    ],
    [
      'retired broker and measurement vocabulary is rejected',
      lintRoutingText('Ask the RuntimeContract for a capability snapshot.')
        .filter(({ code }) => code === 'RETIRED_RUNTIME_CONTRACT').length === 2
        && lintRoutingText('The authority broker signs the measurement ledger.')
          .filter(({ code }) => code === 'RETIRED_RUNTIME_CONTRACT').length === 2,
    ],
    [
      'the surviving dispatch surface passes the lint',
      lintRoutingText(
        'Run node tools/agentic/dispatch.mjs --role code-review '
        + '--prompt-file /tmp/p.md --json, then node tools/agentic/prime.mjs.',
      ).length === 0,
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
