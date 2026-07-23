#!/usr/bin/env node
// Mechanical validator for docs/agentic/STATE.md → json autoloop-config.
//
// Runtime-host intent must survive setup and reconfiguration; engine.profile alone cannot
// distinguish Claude bridge-only, native Codex-only, native opencode-only, and dual-host repos. This validator is the
// fail-closed floor used by setup doctor and every dev/pitcrew preflight.
//
// Usage:
//   node tools/agentic/config-contract.mjs [STATE path] [--host claude|codex|opencode]
//   node tools/agentic/config-contract.mjs --self-test

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CONFIG_VERSION = '0.24.0';
const ALLOWED_HOSTS = new Set(['claude', 'codex', 'opencode']);
const HOST_ORDER = ['claude', 'codex', 'opencode'];
// Native hosts run their own engine profile; when a repo declares one, every role pin for that
// engine must stay null so native sessions inherit their own configuration. At most ONE
// non-Claude host per repo — two would force two contradictory engine profiles.
const NATIVE_PIN_KEYS = {
  codex: ['implementerModel', 'reviewerModel', 'implementerEffort', 'reviewerEffort'],
  opencode: ['implementerModel', 'reviewerModel'],
};

export function extractConfig(markdown) {
  const match = String(markdown).match(
    /```json[ \t]+autoloop-config[ \t]*\r?\n([\s\S]*?)\r?\n```/,
  );
  if (!match) throw new Error('missing ```json autoloop-config``` block');
  try {
    return JSON.parse(match[1]);
  } catch (error) {
    throw new Error(`autoloop-config is not valid JSON: ${error.message}`);
  }
}

export function validateConfig(cfg, { activeHost } = {}) {
  const errors = [];
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return ['config must be a JSON object'];
  }

  if (cfg.version !== CONFIG_VERSION) {
    errors.push(`version must be the known schema version ${CONFIG_VERSION}`);
  }

  const hosts = cfg.runtime?.supportedHosts;
  if (!Array.isArray(hosts) || hosts.length === 0) {
    errors.push('runtime.supportedHosts must be a non-empty array');
  } else {
    const invalid = hosts.filter((host) => !ALLOWED_HOSTS.has(host));
    if (invalid.length) {
      errors.push(`runtime.supportedHosts has unknown value(s): ${[...new Set(invalid)].join(', ')}`);
    }
    if (new Set(hosts).size !== hosts.length) {
      errors.push('runtime.supportedHosts must not contain duplicates');
    }
    const canonical = HOST_ORDER.filter((host) => hosts.includes(host));
    if (invalid.length === 0 && new Set(hosts).size === hosts.length
      && hosts.join(',') !== canonical.join(',')) {
      errors.push('runtime.supportedHosts must use canonical order: claude, then codex, then opencode');
    }
  }

  const profile = cfg.engine?.profile;
  if (!['claude', 'codex', 'opencode'].includes(profile)) {
    errors.push('engine.profile must be "claude", "codex", or "opencode"');
  }

  const nativeHosts = Array.isArray(hosts)
    ? hosts.filter((host) => host !== 'claude' && ALLOWED_HOSTS.has(host))
    : [];
  if (nativeHosts.length > 1) {
    errors.push('runtime.supportedHosts may declare at most one non-Claude host (codex XOR opencode)');
  } else if (nativeHosts.length === 1) {
    const native = nativeHosts[0];
    if (profile !== native) {
      errors.push(`a ${native}-supported repo must use engine.profile "${native}"`);
    }
    for (const key of NATIVE_PIN_KEYS[native]) {
      if (cfg.engine?.[native]?.[key] !== null) {
        errors.push(`engine.${native}.${key} must be null when ${native} is a supported host`);
      }
    }
  }

  if (activeHost !== undefined) {
    if (!ALLOWED_HOSTS.has(activeHost)) {
      errors.push(`active host must be "claude", "codex", or "opencode", got ${JSON.stringify(activeHost)}`);
    } else if (Array.isArray(hosts) && !hosts.includes(activeHost)) {
      errors.push(`active host "${activeHost}" is not declared in runtime.supportedHosts`);
    }
  }

  return errors;
}

function selfTest() {
  const base = {
    version: CONFIG_VERSION,
    runtime: { supportedHosts: ['claude'] },
    engine: {
      profile: 'claude',
      codex: {
        implementerModel: null,
        reviewerModel: null,
        implementerEffort: null,
        reviewerEffort: null,
      },
      opencode: {
        implementerModel: null,
        reviewerModel: null,
      },
    },
  };
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const cases = [
    ['claude profile on Claude', base, { activeHost: 'claude' }, true],
    [
      'Claude bridge profile',
      {
        ...clone(base),
        engine: {
          ...clone(base.engine),
          profile: 'codex',
          codex: {
            ...clone(base.engine.codex),
            reviewerModel: 'bridge-reviewer',
            reviewerEffort: 'high',
          },
        },
      },
      { activeHost: 'claude' },
      true,
    ],
    [
      'native Codex',
      { ...clone(base), runtime: { supportedHosts: ['codex'] }, engine: { ...clone(base.engine), profile: 'codex' } },
      { activeHost: 'codex' },
      true,
    ],
    [
      'dual host',
      { ...clone(base), runtime: { supportedHosts: ['claude', 'codex'] }, engine: { ...clone(base.engine), profile: 'codex' } },
      { activeHost: 'codex' },
      true,
    ],
    ['missing host set', { ...clone(base), runtime: {} }, {}, false],
    ['legacy Codex profile without host set', { ...clone(base), runtime: {}, engine: { ...clone(base.engine), profile: 'codex' } }, {}, false],
    ['empty host set', { ...clone(base), runtime: { supportedHosts: [] } }, {}, false],
    ['duplicate host', { ...clone(base), runtime: { supportedHosts: ['claude', 'claude'] } }, {}, false],
    ['unknown host', { ...clone(base), runtime: { supportedHosts: ['desktop'] } }, {}, false],
    ['noncanonical host order', { ...clone(base), runtime: { supportedHosts: ['codex', 'claude'] }, engine: { ...clone(base.engine), profile: 'codex' } }, {}, false],
    [
      'Codex with Claude profile',
      { ...clone(base), runtime: { supportedHosts: ['codex'] } },
      {},
      false,
    ],
    [
      'Codex with a pin',
      {
        ...clone(base),
        runtime: { supportedHosts: ['codex'] },
        engine: {
          ...clone(base.engine),
          profile: 'codex',
          codex: { ...clone(base.engine.codex), reviewerModel: 'gpt-example' },
        },
      },
      {},
      false,
    ],
    ['active host omitted', base, { activeHost: 'codex' }, false],
    ['missing version', { ...clone(base), version: undefined }, {}, false],
    ['unknown version', { ...clone(base), version: '0.17.0' }, {}, false],
    [
      'native opencode',
      { ...clone(base), runtime: { supportedHosts: ['opencode'] }, engine: { ...clone(base.engine), profile: 'opencode' } },
      { activeHost: 'opencode' },
      true,
    ],
    [
      'dual host opencode',
      { ...clone(base), runtime: { supportedHosts: ['claude', 'opencode'] }, engine: { ...clone(base.engine), profile: 'opencode' } },
      { activeHost: 'opencode' },
      true,
    ],
    [
      'Claude opencode bridge profile',
      {
        ...clone(base),
        engine: {
          ...clone(base.engine),
          profile: 'opencode',
          opencode: { ...clone(base.engine.opencode), reviewerModel: 'provider/bridge-reviewer' },
        },
      },
      { activeHost: 'claude' },
      true,
    ],
    [
      'codex plus opencode',
      { ...clone(base), runtime: { supportedHosts: ['claude', 'codex', 'opencode'] }, engine: { ...clone(base.engine), profile: 'codex' } },
      {},
      false,
    ],
    [
      'two non-Claude hosts',
      { ...clone(base), runtime: { supportedHosts: ['codex', 'opencode'] }, engine: { ...clone(base.engine), profile: 'codex' } },
      {},
      false,
    ],
    [
      'opencode with Claude profile',
      { ...clone(base), runtime: { supportedHosts: ['opencode'] } },
      {},
      false,
    ],
    [
      'opencode with a pin',
      {
        ...clone(base),
        runtime: { supportedHosts: ['opencode'] },
        engine: {
          ...clone(base.engine),
          profile: 'opencode',
          opencode: { ...clone(base.engine.opencode), reviewerModel: 'provider/pinned' },
        },
      },
      {},
      false,
    ],
    [
      'noncanonical opencode order',
      { ...clone(base), runtime: { supportedHosts: ['opencode', 'claude'] }, engine: { ...clone(base.engine), profile: 'opencode' } },
      {},
      false,
    ],
    ['opencode active host omitted', base, { activeHost: 'opencode' }, false],
  ];

  let ok = true;
  for (const [name, cfg, options, expected] of cases) {
    const valid = validateConfig(cfg, options).length === 0;
    if (valid !== expected) {
      console.error(`FAIL ${name}: expected valid=${expected}, got ${valid}`);
      ok = false;
    }
  }

  const extracted = extractConfig(
    `before\n\n\`\`\`json autoloop-config\n${JSON.stringify(base)}\n\`\`\`\n`,
  );
  if (extracted.engine.profile !== 'claude') {
    console.error('FAIL config extraction');
    ok = false;
  }

  const argCases = [
    ['positional only', ['/tmp/S.md'], { statePath: '/tmp/S.md', activeHost: undefined }],
    ['positional then --host', ['/tmp/S.md', '--host', 'codex'], { statePath: '/tmp/S.md', activeHost: 'codex' }],
    ['--host then positional', ['--host', 'claude', '/tmp/S.md'], { statePath: '/tmp/S.md', activeHost: 'claude' }],
    ['default path', [], { statePath: 'docs/agentic/STATE.md', activeHost: undefined }],
    ['self-test flag', ['--self-test'], { selfTest: true }],
    ['--host without value', ['--host'], { error: true }],
    ['--host eating a flag', ['--host', '--self-test'], { error: true }],
    ['unknown flag', ['--frobnicate'], { error: true }],
    ['two positionals', ['a.md', 'b.md'], { error: true }],
  ];
  for (const [name, argv, expected] of argCases) {
    const got = parseArgs(argv);
    const pass = expected.error
      ? got.error !== null
      : got.error === null
        && (expected.statePath === undefined || got.statePath === expected.statePath)
        && (!('activeHost' in expected) || got.activeHost === expected.activeHost)
        && (expected.selfTest === undefined || got.selfTest === expected.selfTest);
    if (!pass) {
      console.error(`FAIL parseArgs ${name}: got ${JSON.stringify(got)}`);
      ok = false;
    }
  }

  console.log(ok ? `self-test OK (${cases.length + 1 + argCases.length} cases)` : 'self-test FAILED');
  return ok;
}

export function parseArgs(args) {
  const parsed = { statePath: 'docs/agentic/STATE.md', activeHost: undefined, selfTest: false, error: null };
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--self-test') {
      parsed.selfTest = true;
    } else if (arg === '--host') {
      const value = args[i + 1];
      if (!value || value.startsWith('-')) {
        parsed.error = '--host requires a value: claude|codex|opencode';
        return parsed;
      }
      parsed.activeHost = value;
      i += 1;
    } else if (arg.startsWith('-')) {
      parsed.error = `unknown flag: ${arg}`;
      return parsed;
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length > 1) {
    parsed.error = `expected at most one STATE path, got: ${positionals.join(' ')}`;
    return parsed;
  }
  if (positionals.length === 1) parsed.statePath = positionals[0];
  return parsed;
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.log(`FAIL  autoloop config: ${parsed.error} — usage: config-contract.mjs [STATE path] [--host claude|codex|opencode] | --self-test`);
    process.exit(2);
  }
  if (parsed.selfTest) process.exit(selfTest() ? 0 : 1);

  // FAIL lines go to stdout: SessionStart hooks inject stdout only, and the skill
  // contract keys on FAIL lines in the injected report. Exit codes still signal.
  let cfg;
  try {
    cfg = extractConfig(readFileSync(parsed.statePath, 'utf8'));
  } catch (error) {
    console.log(`FAIL  autoloop config: ${error.message}`);
    process.exit(1);
  }

  const errors = validateConfig(cfg, { activeHost: parsed.activeHost });
  if (errors.length) {
    for (const error of errors) console.log(`FAIL  autoloop config: ${error}`);
    process.exit(1);
  }

  const hosts = cfg.runtime.supportedHosts.join(',');
  console.log(`PASS  autoloop config v${cfg.version} · hosts ${hosts} · engine ${cfg.engine.profile}`);
}

// realpath comparison: the naive `file://${argv[1]}` string check fails OPEN (script
// silently never runs) on percent-encoded paths (spaces, non-ASCII) and symlinks.
const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMain) main();
