#!/usr/bin/env node

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONFIG_VERSION = '0.26.0';

// 0.25.0 carried route-scoped adapter tuning and a measurement capture switch.
// Both named machinery that no longer exists (a closed route catalog; a
// measurement ledger), so 0.26.0 drops them and the migration below removes the
// keys rather than leaving dead options in every installed STATE.
const PRIOR_CONFIG_VERSION = '0.25.0';
const LEGACY_CONFIG_VERSION = '0.24.0';
const PROJECT_KEYS = [
  'version',
  'baseBranch',
  'gate',
  'merge',
  'tracker',
  'review',
  'caps',
];
const CAP_RANGES = {
  gateRetriesPerUnit: { min: 0, max: 20, integer: true },
  reviseRoundsPerPr: { min: 0, max: 20, integer: true },
  codeReviewRoundsPerUnit: { min: 1, max: 20, integer: true },
  sliceMaxLines: { min: 1, max: 10000, integer: true },
  sliceMaxFiles: { min: 1, max: 1000, integer: true },
};
const LEGACY_CAP_RANGES = {
  runWallClockHours: { min: 0.25, max: 168, integer: false },
  ...CAP_RANGES,
};
const ADAPTER_OPTION_KEYS = {
  'claude.native': ['implementerModel', 'reviewerModel'],
  'claude.codex-exec': [
    'implementerModel',
    'reviewerModel',
    'implementerEffort',
    'reviewerEffort',
  ],
  'claude.opencode-exec': ['implementerModel', 'reviewerModel'],
};
const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const MODEL_PATTERNS = {
  'claude.native': /^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/u,
  'claude.codex-exec': /^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/u,
  'claude.opencode-exec': /^[A-Za-z0-9][A-Za-z0-9._:@+-]*\/[A-Za-z0-9][A-Za-z0-9._:@+-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:@+-]*)*$/u,
};
const LEGACY_MODEL_ROUTES = {
  claude: 'claude.native',
  codex: 'claude.codex-exec',
  opencode: 'claude.opencode-exec',
};
const JIRA_EPIC_KEY = /^[A-Z][A-Z0-9_]{1,19}-[1-9][0-9]*$/u;
const ATLASSIAN_CLOUD_ID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/u;
const LEGACY_HOST_SETS = new Set([
  'claude',
  'codex',
  'opencode',
  'claude,codex',
  'claude,opencode',
]);
const LEGACY_COMBINATIONS = new Set([
  'claude|claude',
  'claude|codex',
  'claude|opencode',
  'codex|codex',
  'opencode|opencode',
  'claude,codex|codex',
  'claude,opencode|opencode',
]);
const LEGACY_TUNING_KEYS = {
  claude: ['implementerModel', 'reviewerModel'],
  codex: [
    'implementerModel',
    'reviewerModel',
    'implementerEffort',
    'reviewerEffort',
  ],
  opencode: ['implementerModel', 'reviewerModel'],
};
const HOST_ORDER = ['claude', 'codex', 'opencode'];
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validEpicKey = (value) => typeof value === 'string' && JIRA_EPIC_KEY.test(value);
const validCloudId = (value) => typeof value === 'string' && ATLASSIAN_CLOUD_ID.test(value);

function childPath(parent, key) {
  const plain = /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key);
  if (!parent) return plain ? key : `[${JSON.stringify(key)}]`;
  return plain ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

function validateObjectShape(value, path, required, optional, errors) {
  if (!isRecord(value)) {
    errors.push(`${path || 'config'}: must be a JSON object`);
    return false;
  }

  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!hasOwn(value, key)) errors.push(`${childPath(path, key)}: is required`);
  }
  for (const key of Object.keys(value).sort()) {
    if (!allowed.has(key)) errors.push(`${childPath(path, key)}: unknown key`);
  }
  return true;
}

function validateVersion(value, expected, errors) {
  if (value !== expected) errors.push(`version: must equal "${expected}"`);
}

function validBaseBranch(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255) return false;
  if (
    value !== value.trim()
    || value === '@'
    || value === 'HEAD'
    || value.startsWith('-')
    || value.startsWith('refs/')
  ) {
    return false;
  }
  if (
    value.startsWith('/')
    || value.endsWith('/')
    || value.endsWith('.')
    || value.includes('..')
    || value.includes('//')
    || value.includes('@{')
    || /[\u0000-\u0020\u007f~^:?*[\]\\]/u.test(value)
  ) {
    return false;
  }
  return value.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.lock'));
}

function validateBaseBranch(value, errors) {
  if (!validBaseBranch(value)) errors.push('baseBranch: must be a valid short Git branch name');
}

function validateCommand(value, path, nullable, errors) {
  if (nullable && value === null) return;
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 4096
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    const suffix = nullable ? ' or null' : '';
    errors.push(`${path}: must be a non-empty single-line command${suffix}`);
  }
}

function validateGate(value, errors) {
  if (!validateObjectShape(value, 'gate', ['command'], ['quickCommand', 'setupCommand'], errors)) {
    return;
  }
  if (hasOwn(value, 'command')) validateCommand(value.command, 'gate.command', false, errors);
  if (hasOwn(value, 'quickCommand')) {
    validateCommand(value.quickCommand, 'gate.quickCommand', true, errors);
  }
  if (hasOwn(value, 'setupCommand')) {
    validateCommand(value.setupCommand, 'gate.setupCommand', true, errors);
  }
}

function validateMerge(value, expectedVersion, errors) {
  // Schema 0.24.0 predates the acknowledgement, so migration must be able to read
  // a legacy non-manual policy without demanding a field that could not exist.
  const legacy = expectedVersion === LEGACY_CONFIG_VERSION;
  if (!validateObjectShape(
    value,
    'merge',
    ['policy'],
    legacy ? [] : ['unverifiedInvocationAcknowledged', 'soloOperatorAcknowledged'],
    errors,
  )) return;
  if (hasOwn(value, 'policy') && !['manual', 'ratified', 'auto'].includes(value.policy)) {
    errors.push('merge.policy: must be "manual", "ratified", or "auto"');
  }
  // No supported transport can prove who requested a run, so a non-manual policy
  // is a deliberate, recorded acceptance of that risk rather than a default. The
  // acknowledgement is meaningless under manual, and a dead option is a defect.
  if (legacy) return;
  // Whether a non-manual policy *requires* the acknowledgement is Runtime's
  // decision, so the failure names the real remedy instead of surfacing as a
  // migration error. The schema only rejects a meaningless value here.
  const acknowledged = value.unverifiedInvocationAcknowledged;
  const nonManual = value.policy === 'ratified' || value.policy === 'auto';
  if (hasOwn(value, 'unverifiedInvocationAcknowledged') && acknowledged !== true) {
    errors.push(
      'merge.unverifiedInvocationAcknowledged: must be true when present',
    );
  } else if (!nonManual && acknowledged === true) {
    errors.push(
      'merge.unverifiedInvocationAcknowledged: only valid with a non-manual merge.policy',
    );
  }
  // Solo-operator relaxations are a second, separate risk acceptance layered on the
  // invocation acknowledgement: they additionally waive identity separation, so a
  // solo flag without the invocation acknowledgement is an incoherent record.
  if (!hasOwn(value, 'soloOperatorAcknowledged')) return;
  const solo = value.soloOperatorAcknowledged;
  if (solo !== true) {
    errors.push('merge.soloOperatorAcknowledged: must be true when present');
  } else if (!nonManual) {
    errors.push(
      'merge.soloOperatorAcknowledged: only valid with a non-manual merge.policy',
    );
  } else if (acknowledged !== true) {
    errors.push(
      'merge.soloOperatorAcknowledged: requires merge.unverifiedInvocationAcknowledged: true',
    );
  }
}

// Measurement capture is opt-in until the pipeline's producers can finalize a
// record: with capture off, prime runs attest -> open -> scan, commands run
// unmeasured, and a close is just the finish decision. 'events' restores the
// full event ceremony per repository; flipping the key back is the whole
// migration. The pipeline delivers no enforcement while pending-evidence, so
// its per-run protocol cost is pure tax in the interim (live runs measured
// 3-6 minutes of it).
function validateMeasurementCapture(value, errors) {
  if (!validateObjectShape(value, 'measurement', ['capture'], [], errors)) return;
  if (!['off', 'events'].includes(value.capture)) {
    errors.push('measurement.capture: must be "off" or "events"');
  }
}

function validateTracker(value, errors) {
  if (!isRecord(value)) {
    errors.push('tracker: must be a JSON object');
    return;
  }
  const provider = value.provider;
  const required = provider === 'jira'
    ? ['provider', 'epicKey', 'cloudId']
    : ['provider'];
  if (!validateObjectShape(value, 'tracker', required, [], errors)) return;
  if (!hasOwn(value, 'provider')) return;
  if (!['none', 'jira'].includes(provider)) {
    errors.push('tracker.provider: must be "none" or "jira"');
    return;
  }
  if (provider === 'jira') {
    if (hasOwn(value, 'epicKey') && !validEpicKey(value.epicKey)) {
      errors.push('tracker.epicKey: must be a safe Jira epic issue key');
    }
    if (hasOwn(value, 'cloudId') && !validCloudId(value.cloudId)) {
      errors.push('tracker.cloudId: must be an Atlassian cloud UUID');
    }
  }
}

function validateLegacyTracker(value, errors) {
  if (!['none', 'jira'].includes(value)) {
    errors.push('tracker: must be "none" or "jira" in schema 0.24.0');
  }
}

function validChecklistPath(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 1024
    || value !== value.trim()
    || value.startsWith('/')
    || value.startsWith('~')
    || /^[A-Za-z]:/u.test(value)
    || /[\u0000-\u001f\u007f\\]/u.test(value)
  ) {
    return false;
  }
  return value.split('/').every((part) => part && part !== '.' && part !== '..');
}

function validateReview(value, errors) {
  if (!validateObjectShape(value, 'review', ['checklistPath'], [], errors)) return;
  if (hasOwn(value, 'checklistPath') && !validChecklistPath(value.checklistPath)) {
    errors.push('review.checklistPath: must be a normalized repository-relative path');
  }
}

function validateCapValues(value, ranges, keys, errors) {
  for (const key of keys) {
    if (!hasOwn(value, key)) continue;
    const candidate = value[key];
    const { min, max, integer } = ranges[key];
    if (
      typeof candidate !== 'number'
      || !Number.isFinite(candidate)
      || (integer && !Number.isInteger(candidate))
      || candidate < min
      || candidate > max
    ) {
      const kind = integer ? 'an integer' : 'a finite number';
      errors.push(`caps.${key}: must be ${kind} from ${min} through ${max}`);
    }
  }
}

function validateCaps(value, errors) {
  const keys = Object.keys(CAP_RANGES);
  if (!validateObjectShape(value, 'caps', keys, [], errors)) return;
  validateCapValues(value, CAP_RANGES, keys, errors);
}

function validateLegacyCaps(value, errors) {
  const optional = ['codeReviewRoundsPerUnit'];
  const required = Object.keys(LEGACY_CAP_RANGES).filter(
    (key) => !optional.includes(key),
  );
  if (!validateObjectShape(value, 'caps', required, optional, errors)) return;
  validateCapValues(
    value,
    LEGACY_CAP_RANGES,
    [...required, ...optional],
    errors,
  );
}

function validModel(value, route) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && MODEL_PATTERNS[route].test(value);
}

function validateAdapterOptions(value, errors) {
  const routes = Object.keys(ADAPTER_OPTION_KEYS);
  if (!validateObjectShape(value, 'adapterOptions', [], routes, errors)) return;

  for (const route of routes) {
    if (!hasOwn(value, route)) continue;
    const path = childPath('adapterOptions', route);
    const options = value[route];
    const allowed = ADAPTER_OPTION_KEYS[route];
    if (!validateObjectShape(options, path, [], allowed, errors)) continue;
    if (Object.keys(options).length === 0) {
      errors.push(`${path}: must contain at least one tuning option`);
    }
    for (const key of allowed) {
      if (!hasOwn(options, key)) continue;
      const optionPath = childPath(path, key);
      if (key.endsWith('Effort')) {
        if (!EFFORTS.has(options[key])) {
          errors.push(`${optionPath}: must be an allowlisted reasoning effort`);
        }
      } else if (!validModel(options[key], route)) {
        errors.push(`${optionPath}: must match the route-safe model identifier grammar`);
      }
    }
  }
}

function validateProjectValues(cfg, expectedVersion, errors) {
  if (hasOwn(cfg, 'version')) validateVersion(cfg.version, expectedVersion, errors);
  if (hasOwn(cfg, 'baseBranch')) validateBaseBranch(cfg.baseBranch, errors);
  if (hasOwn(cfg, 'gate')) validateGate(cfg.gate, errors);
  if (hasOwn(cfg, 'merge')) validateMerge(cfg.merge, expectedVersion, errors);
  if (hasOwn(cfg, 'tracker')) {
    if (expectedVersion === LEGACY_CONFIG_VERSION) {
      validateLegacyTracker(cfg.tracker, errors);
    } else {
      validateTracker(cfg.tracker, errors);
    }
  }
  if (hasOwn(cfg, 'review')) validateReview(cfg.review, errors);
  if (hasOwn(cfg, 'caps')) {
    if (expectedVersion === LEGACY_CONFIG_VERSION) {
      validateLegacyCaps(cfg.caps, errors);
    } else {
      validateCaps(cfg.caps, errors);
    }
  }
}

export function validateConfig(cfg) {
  const errors = [];
  if (!validateObjectShape(cfg, '', PROJECT_KEYS, [], errors)) return errors;
  validateProjectValues(cfg, CONFIG_VERSION, errors);
  return errors;
}

export const validateProjectConfig = validateConfig;

function validatePriorConfig(cfg) {
  const errors = [];
  if (!validateObjectShape(
    cfg,
    '',
    PROJECT_KEYS,
    ['adapterOptions', 'measurement'],
    errors,
  )) return errors;
  validateProjectValues(cfg, PRIOR_CONFIG_VERSION, errors);
  if (hasOwn(cfg, 'adapterOptions')) validateAdapterOptions(cfg.adapterOptions, errors);
  if (hasOwn(cfg, 'measurement')) validateMeasurementCapture(cfg.measurement, errors);
  return errors;
}

export function extractConfig(markdown) {
  const pattern = /```json[ \t]+autoloop-config[ \t]*\r?\n([\s\S]*?)\r?\n```/gu;
  const matches = [...String(markdown).matchAll(pattern)];
  if (matches.length === 0) throw new Error('missing ```json autoloop-config``` block');
  if (matches.length > 1) throw new Error('multiple ```json autoloop-config``` blocks');
  try {
    return JSON.parse(matches[0][1]);
  } catch (error) {
    const position = /\bposition (\d+)\b/u.exec(String(error?.message))?.[1];
    const location = position ? ` at byte ${position}` : '';
    throw new Error(`autoloop-config is not valid JSON${location}`);
  }
}

function legacyHostsValid(hosts) {
  if (!Array.isArray(hosts) || hosts.length === 0) return false;
  if (hosts.some((host) => typeof host !== 'string' || !HOST_ORDER.includes(host))) return false;
  if (new Set(hosts).size !== hosts.length) return false;
  const canonical = HOST_ORDER.filter((host) => hosts.includes(host));
  return hosts.join(',') === canonical.join(',') && LEGACY_HOST_SETS.has(hosts.join(','));
}

function validateLegacyRuntime(value, errors) {
  if (!validateObjectShape(value, 'runtime', ['supportedHosts'], [], errors)) return;
  if (!hasOwn(value, 'supportedHosts')) return;
  const hosts = value.supportedHosts;
  if (!Array.isArray(hosts) || hosts.length === 0) {
    errors.push('runtime.supportedHosts: must be a non-empty array');
    return;
  }
  if (hosts.some((host) => typeof host !== 'string' || !HOST_ORDER.includes(host))) {
    errors.push('runtime.supportedHosts: must contain only known hosts');
  }
  if (new Set(hosts).size !== hosts.length) {
    errors.push('runtime.supportedHosts: must not contain duplicates');
  }
  const canonical = HOST_ORDER.filter((host) => hosts.includes(host));
  if (
    hosts.every((host) => typeof host === 'string' && HOST_ORDER.includes(host))
    && new Set(hosts).size === hosts.length
    && hosts.join(',') !== canonical.join(',')
  ) {
    errors.push('runtime.supportedHosts: must use canonical host order');
  }
  if (
    hosts.every((host) => typeof host === 'string' && HOST_ORDER.includes(host))
    && new Set(hosts).size === hosts.length
    && hosts.join(',') === canonical.join(',')
    && !LEGACY_HOST_SETS.has(hosts.join(','))
  ) {
    errors.push('runtime.supportedHosts: unsupported legacy host set');
  }
}

function validateLegacyTuning(value, engine, errors) {
  const path = `engine.${engine}`;
  const keys = LEGACY_TUNING_KEYS[engine];
  if (!validateObjectShape(value, path, [], keys, errors)) return;
  for (const key of keys) {
    if (!hasOwn(value, key) || value[key] === null) continue;
    const optionPath = `${path}.${key}`;
    if (key.endsWith('Effort')) {
      if (!EFFORTS.has(value[key])) {
        errors.push(`${optionPath}: must be null or an allowlisted reasoning effort`);
      }
    } else if (!validModel(value[key], LEGACY_MODEL_ROUTES[engine])) {
      errors.push(`${optionPath}: must be null or match the route-safe model identifier grammar`);
    }
  }
}

function validateNativeNullPins(engine, host, errors) {
  if (!isRecord(engine[host])) return;
  for (const key of LEGACY_TUNING_KEYS[host]) {
    if (engine[host][key] !== null) {
      errors.push(`engine.${host}.${key}: must be null when ${host} is a supported host`);
    }
  }
}

function validateLegacyEngine(value, hosts, errors) {
  const engines = Object.keys(LEGACY_TUNING_KEYS);
  if (!validateObjectShape(value, 'engine', ['profile'], engines, errors)) return;
  for (const engine of engines) {
    if (hasOwn(value, engine)) validateLegacyTuning(value[engine], engine, errors);
  }

  const profile = value.profile;
  if (!engines.includes(profile)) {
    errors.push('engine.profile: must be "claude", "codex", or "opencode"');
  } else if (legacyHostsValid(hosts) && !LEGACY_COMBINATIONS.has(`${hosts.join(',')}|${profile}`)) {
    errors.push('engine.profile: is incompatible with runtime.supportedHosts');
  }

  if (Array.isArray(hosts) && hosts.includes('codex')) {
    if (!hasOwn(value, 'codex') || !isRecord(value.codex)) {
      errors.push('engine.codex: is required for a native Codex legacy config');
    } else {
      validateNativeNullPins(value, 'codex', errors);
    }
  }
  if (Array.isArray(hosts) && hosts.includes('opencode')) {
    if (!hasOwn(value, 'opencode') || !isRecord(value.opencode)) {
      errors.push('engine.opencode: is required for a native opencode legacy config');
    } else {
      validateNativeNullPins(value, 'opencode', errors);
    }
  }
}

function validateLegacyConfig(cfg) {
  const errors = [];
  if (!validateObjectShape(cfg, '', [...PROJECT_KEYS, 'runtime', 'engine'], [], errors)) {
    return errors;
  }
  validateProjectValues(cfg, LEGACY_CONFIG_VERSION, errors);
  if (hasOwn(cfg, 'runtime')) validateLegacyRuntime(cfg.runtime, errors);
  if (hasOwn(cfg, 'engine')) {
    validateLegacyEngine(cfg.engine, isRecord(cfg.runtime) ? cfg.runtime.supportedHosts : undefined, errors);
  }
  return errors;
}

function migrateLegacyTracker(provider, migrationFacts) {
  if (provider === 'none') return { ok: true, tracker: { provider: 'none' } };

  const errors = [];
  const trackerFacts = isRecord(migrationFacts) ? migrationFacts.tracker : undefined;
  if (!isRecord(trackerFacts)) {
    errors.push('migrationFacts.tracker.epicKey: is required for a Jira migration');
    errors.push('migrationFacts.tracker.cloudId: is required for a Jira migration');
    return { ok: false, errors };
  }
  validateObjectShape(migrationFacts, 'migrationFacts', ['tracker'], [], errors);
  validateObjectShape(
    trackerFacts,
    'migrationFacts.tracker',
    ['epicKey', 'cloudId'],
    [],
    errors,
  );
  if (hasOwn(trackerFacts, 'epicKey') && !validEpicKey(trackerFacts.epicKey)) {
    errors.push('migrationFacts.tracker.epicKey: must be a safe Jira epic issue key');
  }
  if (hasOwn(trackerFacts, 'cloudId') && !validCloudId(trackerFacts.cloudId)) {
    errors.push('migrationFacts.tracker.cloudId: must be an Atlassian cloud UUID');
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    tracker: {
      provider: 'jira',
      epicKey: trackerFacts.epicKey,
      cloudId: trackerFacts.cloudId,
    },
  };
}

function copyProjectConfig(cfg, tracker) {
  const gate = { command: cfg.gate.command };
  for (const key of ['quickCommand', 'setupCommand']) {
    if (hasOwn(cfg.gate, key)) gate[key] = cfg.gate[key];
  }
  const caps = {};
  for (const key of Object.keys(CAP_RANGES)) {
    caps[key] = key === 'codeReviewRoundsPerUnit'
      ? (cfg.caps[key] ?? 5)
      : cfg.caps[key];
  }
  return {
    version: PRIOR_CONFIG_VERSION,
    baseBranch: cfg.baseBranch,
    gate,
    merge: { policy: 'manual' },
    tracker,
    review: { checklistPath: cfg.review.checklistPath },
    caps,
  };
}

function effectiveLegacyAdapter(hosts, profile) {
  if (hosts.length !== 1 || hosts[0] !== 'claude') return null;
  if (profile === 'claude') return { engine: 'claude', route: 'claude.native' };
  if (profile === 'codex') return { engine: 'codex', route: 'claude.codex-exec' };
  return { engine: 'opencode', route: 'claude.opencode-exec' };
}

const PRE_LEGACY_CONFIG_VERSION = '0.23.0';

// 0.23.0 predates three additive fields and the third engine block. Every
// difference is deterministic, so this hop needs no supplemental facts; the
// tracker stays a string until the 0.24.0 -> 0.25.0 hop reshapes it.
export function migrateConfig023To024(cfg) {
  if (!isRecord(cfg) || cfg.version !== PRE_LEGACY_CONFIG_VERSION) {
    return {
      ok: false,
      code: 'INVALID_LEGACY_CONFIG',
      errors: [`version: must equal "${PRE_LEGACY_CONFIG_VERSION}"`],
      warnings: [],
    };
  }
  const config = structuredClone(cfg);
  const warnings = [];
  config.version = LEGACY_CONFIG_VERSION;
  if (isRecord(config.gate) && !hasOwn(config.gate, 'quickCommand')) {
    config.gate.quickCommand = null;
    warnings.push('gate.quickCommand: added as null');
  }
  if (isRecord(config.caps) && !hasOwn(config.caps, 'codeReviewRoundsPerUnit')) {
    config.caps.codeReviewRoundsPerUnit = 5;
    warnings.push('caps.codeReviewRoundsPerUnit: defaulted to 5');
  }
  if (isRecord(config.engine) && !isRecord(config.engine.opencode)) {
    config.engine.opencode = { implementerModel: null, reviewerModel: null };
    warnings.push('engine.opencode: added with null tuning');
  }
  const errors = validateLegacyConfig(config);
  if (errors.length > 0) {
    return { ok: false, code: 'INVALID_LEGACY_CONFIG', errors, warnings: [] };
  }
  return { ok: true, config, warnings };
}

// Ordered so a caller asks to be brought current and never names a version
// pair. A new schema appends one step here instead of adding a function whose
// name every caller and skill must learn.
const MIGRATION_STEPS = Object.freeze([
  Object.freeze({
    from: PRE_LEGACY_CONFIG_VERSION,
    apply: (cfg) => migrateConfig023To024(cfg),
  }),
  Object.freeze({
    from: LEGACY_CONFIG_VERSION,
    apply: (cfg, facts) => migrateConfig024To025(cfg, facts),
  }),
  Object.freeze({
    from: PRIOR_CONFIG_VERSION,
    apply: (cfg) => migrateConfig025To026(cfg),
  }),
]);

export const MIGRATABLE_CONFIG_VERSIONS = Object.freeze(
  MIGRATION_STEPS.map((step) => step.from),
);

export function migrateProjectConfig(cfg, migrationFacts) {
  if (!isRecord(cfg) || typeof cfg.version !== 'string') {
    return {
      ok: false,
      code: 'INVALID_LEGACY_CONFIG',
      errors: ['version: must be a string'],
      warnings: [],
    };
  }
  if (cfg.version === CONFIG_VERSION) {
    return { ok: true, config: structuredClone(cfg), warnings: [], migrated: false };
  }
  let current = cfg;
  const warnings = [];
  let migrated = false;
  for (let guard = 0; guard < MIGRATION_STEPS.length + 1; guard += 1) {
    if (current.version === CONFIG_VERSION) {
      return { ok: true, config: current, warnings, migrated };
    }
    const step = MIGRATION_STEPS.find((candidate) => candidate.from === current.version);
    if (step === undefined) {
      return {
        ok: false,
        code: 'UNSUPPORTED_CONFIG_VERSION',
        errors: [
          `version: "${current.version}" has no migration path; `
          + `migratable versions are ${MIGRATABLE_CONFIG_VERSIONS.join(', ')}`,
        ],
        warnings,
      };
    }
    const result = step.apply(current, migrationFacts);
    if (!result.ok) return { ...result, warnings: [...warnings, ...result.warnings] };
    warnings.push(...result.warnings);
    current = result.config;
    migrated = true;
  }
  return {
    ok: false,
    code: 'UNSUPPORTED_CONFIG_VERSION',
    errors: ['version: migration chain did not converge'],
    warnings,
  };
}

export function migrateConfig024To025(cfg, migrationFacts) {
  const errors = validateLegacyConfig(cfg);
  if (errors.length > 0) {
    return {
      ok: false,
      code: 'INVALID_LEGACY_CONFIG',
      errors,
      warnings: [],
    };
  }

  const trackerMigration = migrateLegacyTracker(cfg.tracker, migrationFacts);
  if (!trackerMigration.ok) {
    return {
      ok: false,
      code: 'MIGRATION_INPUT_REQUIRED',
      errors: trackerMigration.errors,
      warnings: [],
    };
  }

  const config = copyProjectConfig(cfg, trackerMigration.tracker);
  const warnings = [
    'runtime.supportedHosts: retired routing authority removed',
    'engine.profile: retired routing authority removed',
    'caps.runWallClockHours: retired fixed run cap removed',
  ];
  if (cfg.merge.policy !== 'manual') {
    warnings.push(
      `merge.policy: "${cfg.merge.policy}" reset to "manual" because migration `
      + 'cannot grant an unattended merge you did not re-confirm. '
      + `"${cfg.merge.policy}" is still a valid value: restore it together with `
      + 'merge.unverifiedInvocationAcknowledged: true, which records that no '
      + 'supported invocation transport can prove a human requested the run',
    );
  }
  const adapter = effectiveLegacyAdapter(cfg.runtime.supportedHosts, cfg.engine.profile);
  const retained = {};

  for (const engine of Object.keys(LEGACY_TUNING_KEYS)) {
    const options = cfg.engine[engine];
    if (!isRecord(options)) continue;
    for (const key of LEGACY_TUNING_KEYS[engine]) {
      if (!hasOwn(options, key) || options[key] === null) continue;
      if (adapter?.engine === engine) {
        retained[key] = options[key];
      } else {
        warnings.push(`engine.${engine}.${key}: dormant tuning removed`);
      }
    }
  }

  if (adapter && Object.keys(retained).length > 0) {
    config.adapterOptions = { [adapter.route]: retained };
  }
  if (
    cfg.runtime.supportedHosts.includes('claude')
    && ['codex', 'opencode'].includes(cfg.engine.profile)
  ) {
    warnings.push(
      `engine.profile: interactive and scheduled Claude invocations that depended on this legacy default must add explicit selector "with ${cfg.engine.profile}"`,
    );
  }
  return { ok: true, config, warnings };
}

// 0.25.0 -> 0.26.0 is a pure removal: `adapterOptions` named routes in a closed
// catalog that no longer exists, and `measurement.capture` switched on a ledger
// that no longer exists. Nothing is reshaped, so this hop needs no supplemental
// facts and every remaining value carries across byte for byte.
export function migrateConfig025To026(cfg) {
  const errors = validatePriorConfig(cfg);
  if (errors.length > 0) {
    return { ok: false, code: 'INVALID_LEGACY_CONFIG', errors, warnings: [] };
  }
  const config = structuredClone(cfg);
  const warnings = [];
  if (hasOwn(config, 'adapterOptions')) {
    delete config.adapterOptions;
    warnings.push('adapterOptions: retired route-scoped tuning removed');
  }
  if (hasOwn(config, 'measurement')) {
    delete config.measurement;
    warnings.push('measurement.capture: retired measurement ledger removed');
  }
  config.version = CONFIG_VERSION;
  const remaining = validateConfig(config);
  if (remaining.length > 0) {
    return {
      ok: false,
      code: 'INVALID_LEGACY_CONFIG',
      errors: remaining,
      warnings: [],
    };
  }
  return { ok: true, config, warnings };
}

function projectFixture() {
  return {
    version: CONFIG_VERSION,
    baseBranch: 'main',
    gate: {
      command: 'npm test',
      quickCommand: null,
      setupCommand: null,
    },
    merge: { policy: 'manual' },
    tracker: { provider: 'none' },
    review: { checklistPath: 'docs/agentic/checklist.md' },
    caps: {
      gateRetriesPerUnit: 2,
      reviseRoundsPerPr: 3,
      codeReviewRoundsPerUnit: 5,
      sliceMaxLines: 700,
      sliceMaxFiles: 10,
    },
  };
}

function legacyFixture(hosts, profile) {
  const cfg = projectFixture();
  cfg.version = LEGACY_CONFIG_VERSION;
  cfg.caps.runWallClockHours = 4;
  cfg.tracker = 'none';
  cfg.runtime = { supportedHosts: hosts };
  cfg.engine = {
    profile,
    claude: {
      implementerModel: null,
      reviewerModel: null,
    },
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
  };
  return cfg;
}

function changed(value, change) {
  const copy = structuredClone(value);
  change(copy);
  return copy;
}

function selfTest() {
  let ok = true;
  let count = 0;
  const expect = (name, pass) => {
    count += 1;
    if (pass) return;
    console.error(`FAIL ${name}`);
    ok = false;
  };
  const expectValid = (name, cfg, options) => {
    expect(name, validateConfig(cfg, options).length === 0);
  };
  const expectInvalid = (name, cfg, path) => {
    const errors = validateConfig(cfg);
    expect(name, errors.some((error) => error.startsWith(`${path}:`)));
  };

  const base = projectFixture();
  expectValid('schema 0.25.0 project contract', base);
  expectValid(
    'optional gate commands may be omitted',
    changed(base, (cfg) => {
      delete cfg.gate.quickCommand;
      delete cfg.gate.setupCommand;
    }),
  );
  expectValid(
    'bounded zero retry caps are valid',
    changed(base, (cfg) => {
      cfg.caps.gateRetriesPerUnit = 0;
      cfg.caps.reviseRoundsPerPr = 0;
    }),
  );
  expectInvalid(
    'retired route-scoped adapter tuning is rejected',
    changed(base, (cfg) => {
      cfg.adapterOptions = { 'claude.native': { reviewerModel: 'opus' } };
    }),
    'adapterOptions',
  );
  expectValid('active host is not a ProjectContract input', base, { activeHost: 'unknown' });
  for (const policy of ['manual', 'ratified', 'auto']) {
    expectValid(
      `merge policy ${policy} is valid`,
      changed(base, (cfg) => {
        cfg.merge.policy = policy;
        if (policy !== 'manual') {
          cfg.merge.unverifiedInvocationAcknowledged = true;
        }
      }),
    );
  }
  expectValid(
    'none tracker is a discriminated object',
    changed(base, (cfg) => {
      cfg.tracker = { provider: 'none' };
    }),
  );
  expectValid(
    'Jira tracker requires safe explicit metadata',
    changed(base, (cfg) => {
      cfg.tracker = {
        provider: 'jira',
        epicKey: 'AUTO-123',
        cloudId: '123e4567-e89b-12d3-a456-426614174000',
      };
    }),
  );
  expectInvalid(
    'bare tracker strings are retired in schema 0.25.0',
    changed(base, (cfg) => {
      cfg.tracker = 'none';
    }),
    'tracker',
  );
  expectInvalid(
    'Jira tracker requires an epic key',
    changed(base, (cfg) => {
      cfg.tracker = {
        provider: 'jira',
        cloudId: '123e4567-e89b-12d3-a456-426614174000',
      };
    }),
    'tracker.epicKey',
  );
  expectInvalid(
    'Jira tracker requires a cloud ID',
    changed(base, (cfg) => {
      cfg.tracker = {
        provider: 'jira',
        epicKey: 'AUTO-123',
      };
    }),
    'tracker.cloudId',
  );
  expectInvalid(
    'none tracker rejects Jira metadata',
    changed(base, (cfg) => {
      cfg.tracker = { provider: 'none', epicKey: 'AUTO-123' };
    }),
    'tracker.epicKey',
  );
  expectInvalid(
    'Jira epic key rejects unsafe syntax',
    changed(base, (cfg) => {
      cfg.tracker = {
        provider: 'jira',
        epicKey: 'AUTO-1;command',
        cloudId: '123e4567-e89b-12d3-a456-426614174000',
      };
    }),
    'tracker.epicKey',
  );
  expectInvalid(
    'Jira cloud ID rejects unsafe syntax',
    changed(base, (cfg) => {
      cfg.tracker = {
        provider: 'jira',
        epicKey: 'AUTO-123',
        cloudId: '$(command)',
      };
    }),
    'tracker.cloudId',
  );
  expectInvalid(
    'Jira tracker rejects unknown keys',
    changed(base, (cfg) => {
      cfg.tracker = {
        provider: 'jira',
        epicKey: 'AUTO-123',
        cloudId: '123e4567-e89b-12d3-a456-426614174000',
        route: 'codex',
      };
    }),
    'tracker.route',
  );
  expectValid(
    'cap range boundaries are inclusive',
    changed(base, (cfg) => {
      for (const [key, range] of Object.entries(CAP_RANGES)) {
        cfg.caps[key] = range.max;
      }
    }),
  );

  for (const value of [null, [], 'config']) {
    expectInvalid('config must be an object', value, 'config');
  }
  expectInvalid(
    'unknown schema version',
    changed(base, (cfg) => {
      cfg.version = '0.24.0';
    }),
    'version',
  );
  for (const key of ['gate', 'merge', 'review', 'caps', 'adapterOptions']) {
    expectInvalid(
      `${key} must be an object`,
      changed(base, (cfg) => {
        cfg[key] = [];
      }),
      key,
    );
  }

  for (const key of PROJECT_KEYS) {
    expectInvalid(
      `missing required key ${key}`,
      changed(base, (cfg) => {
        delete cfg[key];
      }),
      key,
    );
  }
  for (const key of [
    'runtime',
    'engine',
    'adapterOptions',
    'measurement',
    'activeHost',
    'requestedEngine',
    'resolvedRoute',
    'capability',
    'outage',
  ]) {
    expectInvalid(
      `persisted authority ${key} is rejected`,
      changed(base, (cfg) => {
        cfg[key] = {};
      }),
      key,
    );
  }

  const branchCases = [
    '',
    ' main',
    '-main',
    'refs/heads/main',
    'release//next',
    'release/../next',
    'main.lock',
    'feature/@{bad',
    'main~1',
    'main new',
    'HEAD',
  ];
  for (const branch of branchCases) {
    expectInvalid(
      'invalid base branch',
      changed(base, (cfg) => {
        cfg.baseBranch = branch;
      }),
      'baseBranch',
    );
  }

  expectInvalid(
    'missing gate command',
    changed(base, (cfg) => {
      delete cfg.gate.command;
    }),
    'gate.command',
  );
  for (const command of ['', ' npm test', 'npm test\nrm -f file', ['npm', 'test']]) {
    expectInvalid(
      'invalid gate command',
      changed(base, (cfg) => {
        cfg.gate.command = command;
      }),
      'gate.command',
    );
  }
  expectInvalid(
    'invalid optional gate command',
    changed(base, (cfg) => {
      cfg.gate.quickCommand = 7;
    }),
    'gate.quickCommand',
  );
  expectInvalid(
    'invalid setup gate command',
    changed(base, (cfg) => {
      cfg.gate.setupCommand = 'npm install\nnpm test';
    }),
    'gate.setupCommand',
  );
  expectInvalid(
    'unknown gate key',
    changed(base, (cfg) => {
      cfg.gate.timeout = 30;
    }),
    'gate.timeout',
  );
  for (const policy of ['', 'classified', null]) {
    expectInvalid(
      'invalid merge policy',
      changed(base, (cfg) => {
        cfg.merge.policy = policy;
      }),
      'merge.policy',
    );
  }
  expectInvalid(
    'unknown merge key',
    changed(base, (cfg) => {
      cfg.merge.route = 'native';
    }),
    'merge.route',
  );
  for (const tracker of ['', 'github', null]) {
    expectInvalid(
      'invalid tracker',
      changed(base, (cfg) => {
        cfg.tracker = tracker;
      }),
      'tracker',
    );
  }
  expectInvalid(
    'tracker provider is required',
    changed(base, (cfg) => {
      cfg.tracker = {};
    }),
    'tracker.provider',
  );
  for (const checklistPath of [
    '',
    '/docs/checklist.md',
    '../checklist.md',
    'docs/../checklist.md',
    'C:\\docs\\checklist.md',
    'docs//checklist.md',
  ]) {
    expectInvalid(
      'invalid checklist path',
      changed(base, (cfg) => {
        cfg.review.checklistPath = checklistPath;
      }),
      'review.checklistPath',
    );
  }
  expectInvalid(
    'unknown review key',
    changed(base, (cfg) => {
      cfg.review.engine = 'codex';
    }),
    'review.engine',
  );

  for (const key of Object.keys(CAP_RANGES)) {
    expectInvalid(
      `missing cap ${key}`,
      changed(base, (cfg) => {
        delete cfg.caps[key];
      }),
      `caps.${key}`,
    );
  }
  const invalidCaps = {
    gateRetriesPerUnit: [-1, 21, 1.5],
    reviseRoundsPerPr: [-1, 21, 1.5],
    codeReviewRoundsPerUnit: [0, 21, 1.5],
    sliceMaxLines: [0, 10001, 1.5],
    sliceMaxFiles: [0, 1001, 1.5],
  };
  for (const [key, values] of Object.entries(invalidCaps)) {
    for (const value of values) {
      expectInvalid(
        `invalid cap ${key}`,
        changed(base, (cfg) => {
          cfg.caps[key] = value;
        }),
        `caps.${key}`,
      );
    }
  }
  expectInvalid(
    'retired wall-clock cap is rejected',
    changed(base, (cfg) => {
      cfg.caps.runWallClockHours = 4;
    }),
    'caps.runWallClockHours',
  );
  expectInvalid(
    'unknown cap',
    changed(base, (cfg) => {
      cfg.caps.dispatchRetries = 2;
    }),
    'caps.dispatchRetries',
  );

  const migrationCases = [
    {
      name: 'Claude native',
      hosts: ['claude'],
      profile: 'claude',
      tune(cfg) {
        cfg.engine.claude.implementerModel = 'sonnet';
        cfg.engine.claude.reviewerModel = 'opus';
      },
      adapterOptions: {
        'claude.native': {
          implementerModel: 'sonnet',
          reviewerModel: 'opus',
        },
      },
      invocationSelector: null,
    },
    {
      name: 'Claude to Codex exec',
      hosts: ['claude'],
      profile: 'codex',
      tune(cfg) {
        cfg.engine.codex.implementerModel = 'gpt-5.6-codex';
        cfg.engine.codex.reviewerModel = 'gpt-5.6-codex';
        cfg.engine.codex.implementerEffort = 'medium';
        cfg.engine.codex.reviewerEffort = 'max';
      },
      adapterOptions: {
        'claude.codex-exec': {
          implementerModel: 'gpt-5.6-codex',
          reviewerModel: 'gpt-5.6-codex',
          implementerEffort: 'medium',
          reviewerEffort: 'max',
        },
      },
      invocationSelector: 'codex',
    },
    {
      name: 'Claude to opencode exec',
      hosts: ['claude'],
      profile: 'opencode',
      tune(cfg) {
        cfg.engine.opencode.implementerModel = 'provider/writer';
        cfg.engine.opencode.reviewerModel = 'provider/reviewer';
      },
      adapterOptions: {
        'claude.opencode-exec': {
          implementerModel: 'provider/writer',
          reviewerModel: 'provider/reviewer',
        },
      },
      invocationSelector: 'opencode',
    },
    {
      name: 'native Codex',
      hosts: ['codex'],
      profile: 'codex',
      adapterOptions: undefined,
      invocationSelector: null,
    },
    {
      name: 'Claude and Codex dual host',
      hosts: ['claude', 'codex'],
      profile: 'codex',
      adapterOptions: undefined,
      invocationSelector: 'codex',
    },
    {
      name: 'native opencode',
      hosts: ['opencode'],
      profile: 'opencode',
      adapterOptions: undefined,
      invocationSelector: null,
    },
    {
      name: 'Claude and opencode dual host',
      hosts: ['claude', 'opencode'],
      profile: 'opencode',
      adapterOptions: undefined,
      invocationSelector: 'opencode',
    },
  ];

  for (const fixture of migrationCases) {
    const legacy = legacyFixture(fixture.hosts, fixture.profile);
    fixture.tune?.(legacy);
    const before = JSON.stringify(legacy);
    const result = migrateConfig024To025(legacy);
    const repeated = migrateConfig024To025(legacy);
    expect(`migration ${fixture.name} succeeds`, result.ok === true);
    expect(`migration ${fixture.name} is pure`, JSON.stringify(legacy) === before);
    expect(`migration ${fixture.name} is deterministic`, JSON.stringify(result) === JSON.stringify(repeated));
    expect(
      `migration ${fixture.name} produces valid schema 0.25.0`,
      result.ok
        && result.config.version === PRIOR_CONFIG_VERSION
        && validatePriorConfig(result.config).length === 0,
    );
    expect(
      `migration ${fixture.name} removes route authority`,
      result.ok && !hasOwn(result.config, 'runtime') && !hasOwn(result.config, 'engine'),
    );
    expect(
      `migration ${fixture.name} maps only effective tuning`,
      result.ok
        && JSON.stringify(result.config.adapterOptions)
          === JSON.stringify(fixture.adapterOptions),
    );
    const hasInvocationWarning = result.ok && result.warnings.some(
      (warning) => warning.includes(`"with ${fixture.invocationSelector}"`),
    );
    expect(
      `migration ${fixture.name} reports invocation change`,
      fixture.invocationSelector === null ? !hasInvocationWarning : hasInvocationWarning,
    );
    if (fixture.invocationSelector !== null) {
      expect(
        `migration ${fixture.name} warns interactive and scheduled callers`,
        result.ok && result.warnings.some(
          (warning) => warning.includes('interactive and scheduled')
            && warning.includes(`explicit selector "with ${fixture.invocationSelector}"`),
        ),
      );
    }
  }

  const legacyWithoutReviewCap = legacyFixture(['claude'], 'claude');
  delete legacyWithoutReviewCap.caps.codeReviewRoundsPerUnit;
  const defaultedReviewCap = migrateConfig024To025(legacyWithoutReviewCap);
  expect(
    'migration materializes the legacy code-review default',
    defaultedReviewCap.ok && defaultedReviewCap.config.caps.codeReviewRoundsPerUnit === 5,
  );
  expect(
    'migration removes the retired fixed run cap',
    defaultedReviewCap.ok
      && !hasOwn(defaultedReviewCap.config.caps, 'runWallClockHours')
      && defaultedReviewCap.warnings.includes(
        'caps.runWallClockHours: retired fixed run cap removed',
      ),
  );

  for (const policy of ['ratified', 'auto']) {
    const legacyNonManual = legacyFixture(['claude'], 'claude');
    legacyNonManual.merge.policy = policy;
    const contained = migrateConfig024To025(legacyNonManual);
    expect(
      `migration contains legacy ${policy} merge policy`,
      contained.ok
        && contained.config.merge.policy === 'manual'
        && contained.warnings.some((warning) =>
          warning.startsWith(`merge.policy: "${policy}" reset to "manual"`)
          && warning.includes('merge.unverifiedInvocationAcknowledged: true')),
    );
  }

  for (const policy of ['ratified', 'auto']) {
    const unacknowledged = { ...projectFixture(), merge: { policy } };
    const acknowledged = {
      ...projectFixture(),
      merge: { policy, unverifiedInvocationAcknowledged: true },
    };
    expect(
      `${policy} accepts both the bare and acknowledged shapes`,
      validateConfig(unacknowledged).length === 0
        && validateConfig(acknowledged).length === 0,
    );
  }
  expect(
    'the acknowledgement is rejected as a dead option under manual policy',
    validateConfig({
      ...projectFixture(),
      merge: { policy: 'manual', unverifiedInvocationAcknowledged: true },
    }).includes(
      'merge.unverifiedInvocationAcknowledged: only valid with a non-manual merge.policy',
    ),
  );
  expect(
    'a false acknowledgement never enables a non-manual policy',
    validateConfig({
      ...projectFixture(),
      merge: { policy: 'auto', unverifiedInvocationAcknowledged: false },
    }).includes(
      'merge.unverifiedInvocationAcknowledged: must be true when present',
    ),
  );

  for (const policy of ['ratified', 'auto']) {
    expect(
      `${policy} accepts the doubly acknowledged solo-operator shape`,
      validateConfig({
        ...projectFixture(),
        merge: {
          policy,
          unverifiedInvocationAcknowledged: true,
          soloOperatorAcknowledged: true,
        },
      }).length === 0,
    );
  }
  expect(
    'solo acknowledgement without the invocation acknowledgement is rejected',
    validateConfig({
      ...projectFixture(),
      merge: { policy: 'auto', soloOperatorAcknowledged: true },
    }).includes(
      'merge.soloOperatorAcknowledged: requires merge.unverifiedInvocationAcknowledged: true',
    ),
  );
  expect(
    'solo acknowledgement is rejected as a dead option under manual policy',
    validateConfig({
      ...projectFixture(),
      merge: {
        policy: 'manual',
        soloOperatorAcknowledged: true,
      },
    }).includes(
      'merge.soloOperatorAcknowledged: only valid with a non-manual merge.policy',
    ),
  );
  expect(
    'a false solo acknowledgement never enables solo relaxations',
    validateConfig({
      ...projectFixture(),
      merge: {
        policy: 'auto',
        unverifiedInvocationAcknowledged: true,
        soloOperatorAcknowledged: false,
      },
    }).includes(
      'merge.soloOperatorAcknowledged: must be true when present',
    ),
  );
  expect(
    'the retired measurement capture switch is rejected outright',
    validateConfig({ ...projectFixture(), measurement: { capture: 'off' } })
      .includes('measurement: unknown key')
      && validateConfig({ ...projectFixture(), measurement: { capture: 'events' } })
        .includes('measurement: unknown key'),
  );

  {
    const legacySolo = legacyFixture(['claude'], 'claude');
    legacySolo.merge.policy = 'auto';
    const migratedSolo = migrateConfig024To025(legacySolo);
    expect(
      'migration never emits a solo-operator acknowledgement',
      migratedSolo.ok
        && !hasOwn(migratedSolo.config.merge, 'soloOperatorAcknowledged'),
    );
  }

  const preLegacyFixture = () => {
    const cfg = legacyFixture(['claude', 'codex'], 'codex');
    cfg.version = PRE_LEGACY_CONFIG_VERSION;
    delete cfg.gate.quickCommand;
    delete cfg.caps.codeReviewRoundsPerUnit;
    delete cfg.engine.opencode;
    return cfg;
  };
  const chained = migrateProjectConfig(preLegacyFixture());
  expect(
    'the chain carries 0.23.0 to the current schema without naming a version pair',
    chained.ok
      && chained.migrated === true
      && chained.config.version === CONFIG_VERSION
      && validateConfig(chained.config).length === 0
      && chained.warnings.includes('gate.quickCommand: added as null')
      && chained.warnings.includes('caps.codeReviewRoundsPerUnit: defaulted to 5')
      && chained.warnings.includes(
        'runtime.supportedHosts: retired routing authority removed',
      ),
  );
  const preLegacyJira = preLegacyFixture();
  preLegacyJira.tracker = 'jira';
  expect(
    'a 0.23.0 Jira tracker still reaches the supplemental-facts gate',
    migrateProjectConfig(preLegacyJira).code === 'MIGRATION_INPUT_REQUIRED'
      && migrateProjectConfig(preLegacyJira, {
        tracker: {
          epicKey: 'AUTO-9',
          cloudId: '123e4567-e89b-12d3-a456-426614174000',
        },
      }).ok === true,
  );
  const alreadyCurrent = migrateProjectConfig(projectFixture());
  expect(
    'a current configuration is returned unchanged and unmigrated',
    alreadyCurrent.ok
      && alreadyCurrent.migrated === false
      && alreadyCurrent.warnings.length === 0,
  );
  const unknownVersion = migrateProjectConfig({
    ...projectFixture(),
    version: '0.19.0',
  });
  expect(
    'an unknown schema is a typed unsupported version, never a silent pass',
    !unknownVersion.ok
      && unknownVersion.code === 'UNSUPPORTED_CONFIG_VERSION'
      && unknownVersion.errors.some(
        (error) => error.includes('0.23.0, 0.24.0, 0.25.0'),
      ),
  );
  expect(
    'the 0.23.0 step refuses a configuration of another version',
    migrateConfig023To024(projectFixture()).code === 'INVALID_LEGACY_CONFIG',
  );
  const legacyNoneTracker = migrateConfig024To025(legacyFixture(['claude'], 'claude'));
  expect(
    'migration converts legacy none tracker',
    legacyNoneTracker.ok
      && JSON.stringify(legacyNoneTracker.config.tracker) === JSON.stringify({ provider: 'none' }),
  );
  const legacyJira = legacyFixture(['claude'], 'claude');
  legacyJira.tracker = 'jira';
  const jiraNeedsFacts = migrateConfig024To025(legacyJira);
  expect(
    'Jira migration without facts returns typed needs-input errors',
    !jiraNeedsFacts.ok
      && jiraNeedsFacts.code === 'MIGRATION_INPUT_REQUIRED'
      && jiraNeedsFacts.errors.some(
        (error) => error.startsWith('migrationFacts.tracker.epicKey:'),
      )
      && jiraNeedsFacts.errors.some(
        (error) => error.startsWith('migrationFacts.tracker.cloudId:'),
      ),
  );
  const jiraFacts = {
    tracker: {
      epicKey: 'AUTO-123',
      cloudId: '123e4567-e89b-12d3-a456-426614174000',
    },
  };
  const jiraBefore = JSON.stringify(legacyJira);
  const jiraFactsBefore = JSON.stringify(jiraFacts);
  const jiraWithFacts = migrateConfig024To025(legacyJira, jiraFacts);
  expect(
    'Jira migration preserves explicit supplemental facts',
    jiraWithFacts.ok
      && JSON.stringify(jiraWithFacts.config.tracker) === JSON.stringify({
        provider: 'jira',
        epicKey: 'AUTO-123',
        cloudId: '123e4567-e89b-12d3-a456-426614174000',
      })
      && validatePriorConfig(jiraWithFacts.config).length === 0,
  );
  expect(
    'Jira migration is pure and deterministic with supplemental facts',
    JSON.stringify(legacyJira) === jiraBefore
      && JSON.stringify(jiraFacts) === jiraFactsBefore
      && JSON.stringify(jiraWithFacts)
        === JSON.stringify(migrateConfig024To025(legacyJira, jiraFacts)),
  );
  const jiraWithUnsafeFacts = migrateConfig024To025(legacyJira, {
    tracker: {
      epicKey: 'AUTO-123',
      cloudId: '$(command)',
    },
  });
  expect(
    'Jira migration rejects unsafe supplemental facts',
    !jiraWithUnsafeFacts.ok
      && jiraWithUnsafeFacts.code === 'MIGRATION_INPUT_REQUIRED'
      && jiraWithUnsafeFacts.errors.some(
        (error) => error.startsWith('migrationFacts.tracker.cloudId:'),
      ),
  );
  const jiraWithUnknownFacts = migrateConfig024To025(legacyJira, {
    tracker: {
      epicKey: 'AUTO-123',
      cloudId: '123e4567-e89b-12d3-a456-426614174000',
      route: 'codex',
    },
  });
  expect(
    'Jira migration rejects unknown supplemental facts',
    !jiraWithUnknownFacts.ok
      && jiraWithUnknownFacts.code === 'MIGRATION_INPUT_REQUIRED'
      && jiraWithUnknownFacts.errors.some(
        (error) => error.startsWith('migrationFacts.tracker.route:'),
      ),
  );

  const nullOnly = migrateConfig024To025(legacyFixture(['claude'], 'claude'));
  expect(
    'migration omits null-only adapter options',
    nullOnly.ok && !hasOwn(nullOnly.config, 'adapterOptions'),
  );

  const dormant = legacyFixture(['claude'], 'claude');
  dormant.engine.claude.reviewerModel = 'opus';
  dormant.engine.codex.reviewerModel = 'dormant-codex';
  dormant.engine.codex.reviewerEffort = 'high';
  dormant.engine.opencode.implementerModel = 'provider/dormant';
  const dormantResult = migrateConfig024To025(dormant);
  expect(
    'migration retains effective tuning and removes dormant tuning',
    dormantResult.ok
      && JSON.stringify(dormantResult.config.adapterOptions) === JSON.stringify({
        'claude.native': { reviewerModel: 'opus' },
      }),
  );
  for (const path of [
    'engine.codex.reviewerModel',
    'engine.codex.reviewerEffort',
    'engine.opencode.implementerModel',
  ]) {
    expect(
      `migration warns for dormant ${path}`,
      dormantResult.ok && dormantResult.warnings.some((warning) => warning.startsWith(`${path}:`)),
    );
  }

  const invalidMigrations = [
    [
      'wrong legacy version',
      changed(legacyFixture(['claude'], 'claude'), (cfg) => {
        cfg.version = '0.23.0';
      }),
      'version',
    ],
    [
      'unknown legacy host',
      changed(legacyFixture(['claude'], 'claude'), (cfg) => {
        cfg.runtime.supportedHosts = ['desktop'];
      }),
      'runtime.supportedHosts',
    ],
    [
      'noncanonical legacy hosts',
      changed(legacyFixture(['claude', 'codex'], 'codex'), (cfg) => {
        cfg.runtime.supportedHosts = ['codex', 'claude'];
      }),
      'runtime.supportedHosts',
    ],
    [
      'unsupported two-native legacy hosts',
      changed(legacyFixture(['codex'], 'codex'), (cfg) => {
        cfg.runtime.supportedHosts = ['codex', 'opencode'];
      }),
      'runtime.supportedHosts',
    ],
    [
      'incompatible legacy profile',
      changed(legacyFixture(['codex'], 'codex'), (cfg) => {
        cfg.engine.profile = 'claude';
      }),
      'engine.profile',
    ],
    [
      'native Codex pin',
      changed(legacyFixture(['codex'], 'codex'), (cfg) => {
        cfg.engine.codex.reviewerModel = 'gpt-5';
      }),
      'engine.codex.reviewerModel',
    ],
    [
      'unknown legacy engine key',
      changed(legacyFixture(['claude'], 'claude'), (cfg) => {
        cfg.engine.variant = 'native';
      }),
      'engine.variant',
    ],
    [
      'unknown legacy tuning key',
      changed(legacyFixture(['claude'], 'codex'), (cfg) => {
        cfg.engine.codex.temperature = 0;
      }),
      'engine.codex.temperature',
    ],
    [
      'invalid legacy model',
      changed(legacyFixture(['claude'], 'claude'), (cfg) => {
        cfg.engine.claude.reviewerModel = 'model with spaces';
      }),
      'engine.claude.reviewerModel',
    ],
    [
      'invalid legacy effort',
      changed(legacyFixture(['claude'], 'codex'), (cfg) => {
        cfg.engine.codex.reviewerEffort = 'extreme';
      }),
      'engine.codex.reviewerEffort',
    ],
    [
      'missing retained project value',
      changed(legacyFixture(['claude'], 'claude'), (cfg) => {
        delete cfg.review;
      }),
      'review',
    ],
    [
      'invalid retained cap',
      changed(legacyFixture(['claude'], 'claude'), (cfg) => {
        cfg.caps.gateRetriesPerUnit = 1000;
      }),
      'caps.gateRetriesPerUnit',
    ],
    [
      'preexisting adapter options',
      changed(legacyFixture(['claude'], 'claude'), (cfg) => {
        cfg.adapterOptions = { 'claude.native': { reviewerModel: 'opus' } };
      }),
      'adapterOptions',
    ],
  ];
  for (const [name, legacy, path] of invalidMigrations) {
    const before = JSON.stringify(legacy);
    const result = migrateConfig024To025(legacy);
    expect(
      `migration rejects ${name}`,
      !result.ok && result.errors.some((error) => error.startsWith(`${path}:`)),
    );
    expect(`failed migration ${name} is pure`, JSON.stringify(legacy) === before);
    expect(`failed migration ${name} emits no warnings`, result.warnings.length === 0);
  }

  {
    const prior = {
      ...projectFixture(),
      version: PRIOR_CONFIG_VERSION,
      adapterOptions: { 'claude.native': { reviewerModel: 'opus' } },
      measurement: { capture: 'events' },
    };
    const before = JSON.stringify(prior);
    const migrated = migrateConfig025To026(prior);
    expect(
      'the 0.25.0 hop drops the retired keys and keeps every remaining value',
      migrated.ok
        && migrated.config.version === CONFIG_VERSION
        && !hasOwn(migrated.config, 'adapterOptions')
        && !hasOwn(migrated.config, 'measurement')
        && JSON.stringify(migrated.config.gate) === JSON.stringify(prior.gate)
        && JSON.stringify(migrated.config.caps) === JSON.stringify(prior.caps)
        && validateConfig(migrated.config).length === 0,
    );
    expect(
      'the 0.25.0 hop names both removals and stays pure and deterministic',
      migrated.warnings.includes('adapterOptions: retired route-scoped tuning removed')
        && migrated.warnings.includes(
          'measurement.capture: retired measurement ledger removed',
        )
        && JSON.stringify(prior) === before
        && JSON.stringify(migrated) === JSON.stringify(migrateConfig025To026(prior)),
    );
    const clean = migrateConfig025To026({
      ...projectFixture(),
      version: PRIOR_CONFIG_VERSION,
    });
    expect(
      'a 0.25.0 configuration without the retired keys migrates without warnings',
      clean.ok && clean.warnings.length === 0
        && validateConfig(clean.config).length === 0,
    );
    expect(
      'the 0.25.0 hop refuses another version and an invalid prior configuration',
      migrateConfig025To026(projectFixture()).code === 'INVALID_LEGACY_CONFIG'
        && migrateConfig025To026({
          ...projectFixture(),
          version: PRIOR_CONFIG_VERSION,
          measurement: { capture: 'all' },
        }).code === 'INVALID_LEGACY_CONFIG',
    );
    const soloPreserved = migrateConfig025To026({
      ...projectFixture(),
      version: PRIOR_CONFIG_VERSION,
      merge: {
        policy: 'auto',
        unverifiedInvocationAcknowledged: true,
        soloOperatorAcknowledged: true,
      },
      adapterOptions: { 'claude.native': { reviewerModel: 'opus' } },
    });
    expect(
      'the 0.25.0 hop preserves the merge policy and both acknowledgements',
      soloPreserved.ok
        && JSON.stringify(soloPreserved.config.merge) === JSON.stringify({
          policy: 'auto',
          unverifiedInvocationAcknowledged: true,
          soloOperatorAcknowledged: true,
        }),
    );
  }

  const extracted = extractConfig(
    `before\n\n\`\`\`json autoloop-config\n${JSON.stringify(base)}\n\`\`\`\n`,
  );
  expect('config extraction', extracted.version === CONFIG_VERSION);
  try {
    extractConfig('no config');
    expect('missing config block', false);
  } catch (error) {
    expect('missing config block', error.message.startsWith('missing '));
  }
  try {
    extractConfig(
      `\`\`\`json autoloop-config\n{"token":"super-secret",}\n\`\`\``,
    );
    expect('invalid JSON config block', false);
  } catch (error) {
    expect(
      'invalid JSON diagnostic excludes values',
      error.message.includes('not valid JSON') && !error.message.includes('super-secret'),
    );
  }
  try {
    const block = `\`\`\`json autoloop-config\n${JSON.stringify(base)}\n\`\`\``;
    extractConfig(`${block}\n${block}`);
    expect('multiple config blocks', false);
  } catch (error) {
    expect('multiple config blocks', error.message.startsWith('multiple '));
  }

  const argCases = [
    ['positional only', ['/tmp/S.md'], { statePath: '/tmp/S.md', selfTest: false }],
    ['default path', [], { statePath: 'docs/agentic/STATE.md', selfTest: false }],
    ['self-test flag', ['--self-test'], { statePath: 'docs/agentic/STATE.md', selfTest: true }],
    ['retired host flag', ['--host', 'codex'], { error: true }],
    ['unknown flag', ['--frobnicate'], { error: true }],
    ['two positionals', ['a.md', 'b.md'], { error: true }],
    ['self-test with positional', ['--self-test', 'a.md'], { error: true }],
  ];
  for (const [name, argv, expected] of argCases) {
    const got = parseArgs(argv);
    const pass = expected.error
      ? got.error !== null
      : got.error === null
        && got.statePath === expected.statePath
        && got.selfTest === expected.selfTest;
    expect(`parseArgs ${name}`, pass);
  }
  expect('parseArgs resolve flag', parseArgs(['--resolve']).resolve === true);
  expect('parseArgs resolve defaults off', parseArgs([]).resolve === false);

  // 2026-07-29: setup's own audit probed `command -v <exe>` and was refused by
  // the repository's PRE-RECONCILE guard — the very file the reconcile was
  // about to replace. A rule with no command gets re-derived as a shell line,
  // and a shell line is the one thing a guard can refuse.
  {
    const present = new Set(['npm', '/repo/tools/gate.mjs']);
    const lookup = (exe) => present.has(exe);
    const rows = resolveConfiguredCommands(
      {
        gate: {
          command: 'npm test',
          quickCommand: 'pnpm lint',
          setupCommand: null,
        },
      },
      lookup,
    );
    expect('resolve examines only the executable', rows[0].executable === 'npm');
    expect('resolve reports a present command', rows[0].resolved === true);
    expect('resolve reports an absent command', rows[1].resolved === false);
    expect('resolve skips an unconfigured command', rows.length === 2);
    expect(
      'resolve names the key so a finding points at the field',
      rows[1].key === 'gate.quickCommand',
    );
    const empty = resolveConfiguredCommands({ gate: { command: '   ' } }, lookup);
    expect('a blank command is not a resolvable command', empty.length === 0);
    const pathShaped = resolveConfiguredCommands(
      { gate: { command: '/repo/tools/gate.mjs --full' } },
      lookup,
    );
    // A path-shaped name never consults PATH, so treating it as a bare name
    // would report a present script as missing.
    expect('a path-shaped command is a file question', pathShaped[0].resolved === true);
  }

  console.log(ok ? `self-test OK (${count} cases)` : 'self-test FAILED');
  return ok;
}

// Whether a configured command could actually run, without running it.
//
// Setup and doctor both owe this answer — "does `cfg.gate.command` still
// resolve" — and until now it was prose telling the reader to check, which the
// reader implemented as `command -v <exe>`. That is a shell probe against the
// repository's OWN vendored guard, and during setup that guard is the
// pre-reconcile copy: a live run was refused mid-audit by the very file the
// reconcile was about to replace. A rule with no command gets re-derived as a
// shell line, and a shell line is the one thing that can be refused. So the
// rule gets a command.
//
// Only the executable is examined — the first word, resolved against PATH the
// way a shell would. Arguments are not inspected and nothing is executed: this
// answers "is it there", never "does it work", and a gate that resolves can
// still fail for its own reasons.
export function resolveConfiguredCommands(cfg, lookup = defaultLookup) {
  const commands = [
    ['gate.command', cfg?.gate?.command],
    ['gate.quickCommand', cfg?.gate?.quickCommand],
    ['gate.setupCommand', cfg?.gate?.setupCommand],
  ];
  return commands
    .filter(([, value]) => typeof value === 'string' && value.trim() !== '')
    .map(([key, value]) => {
      const executable = value.trim().split(/\s+/u)[0];
      return { key, command: value, executable, resolved: lookup(executable) };
    });
}

function defaultLookup(executable) {
  // A path-shaped name is a file question, not a PATH question — `./x` and
  // `/usr/bin/x` never consult PATH, and treating them as bare names would
  // report a present script as missing.
  if (executable.includes('/')) {
    try {
      return statSync(executable).isFile();
    } catch {
      return false;
    }
  }
  const path = process.env.PATH ?? '';
  return path.split(':').filter(Boolean).some((directory) => {
    try {
      return statSync(join(directory, executable)).isFile();
    } catch {
      return false;
    }
  });
}

export function parseArgs(args) {
  const parsed = {
    statePath: 'docs/agentic/STATE.md',
    selfTest: false,
    resolve: false,
    error: null,
  };
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--self-test') {
      if (parsed.selfTest) {
        parsed.error = 'duplicate --self-test flag';
        return parsed;
      }
      parsed.selfTest = true;
    } else if (arg === '--resolve') {
      parsed.resolve = true;
    } else if (arg.startsWith('-')) {
      parsed.error = 'unknown flag';
      return parsed;
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length > 1) {
    parsed.error = 'expected at most one STATE path';
    return parsed;
  }
  if (parsed.selfTest && positionals.length > 0) {
    parsed.error = '--self-test does not accept a STATE path';
    return parsed;
  }
  if (positionals.length === 1) parsed.statePath = positionals[0];
  return parsed;
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.log(
      `FAIL  autoloop config: ${parsed.error} — usage: config-contract.mjs [STATE path] | --self-test`,
    );
    process.exit(2);
  }
  if (parsed.selfTest) process.exit(selfTest() ? 0 : 1);

  let cfg;
  try {
    cfg = extractConfig(readFileSync(parsed.statePath, 'utf8'));
  } catch (error) {
    console.log(`FAIL  autoloop config: ${error.message}`);
    process.exit(1);
  }

  const errors = validateConfig(cfg);
  if (errors.length > 0) {
    for (const error of errors) console.log(`FAIL  autoloop config: ${error}`);
    process.exit(1);
  }
  if (parsed.resolve) {
    const rows = resolveConfiguredCommands(cfg);
    for (const row of rows) {
      console.log(
        `${row.resolved ? 'PASS' : 'FAIL'}  ${row.key}: ${row.executable}`
        + `${row.resolved ? '' : ' is not on PATH'} — ${row.command}`,
      );
    }
    if (rows.length === 0) console.log('NOTE  no gate commands are configured');
    // A command that does not resolve is a finding for the human, never a
    // repair: Setup reports it and never substitutes a command nobody chose.
    if (rows.some((row) => !row.resolved)) process.exit(1);
  }
  console.log(`PASS  autoloop config v${cfg.version}`);
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
