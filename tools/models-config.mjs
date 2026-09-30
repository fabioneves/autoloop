#!/usr/bin/env node
// autoloop — models-config.mjs
//
// The model, reasoning effort and fallback each dispatched step runs on
// (docs/specs/SPEC-model-config.md). Built-in defaults, then the operator's
// global file, then the project's `.autoloop/config.json` `models`, merged per
// role and per field. The global file is written with the defaults when it is
// missing, so the operator always has one to edit.
//
// No artifact is judged by the model that wrote it: a table where a reviewer
// and its writer share a model, fallbacks included, is refused.
//
// Usage: node models-config.mjs [--self-test | --lines]
//        (no argument: the resolved global table as JSON; --lines: the
//        session-start summary)

import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MODEL_ROLES = Object.freeze([
  'plan', 'plan-review', 'implement', 'fix', 'simplify', 'diff-review', 'code-review', 'doubt-review',
]);
export const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const GLOBAL_CONFIG_VERSION = '1';

// Every id carries [1m]: a gateway serves a bare id with a 200k window.
const reviewer = (fallback) => Object.freeze({ model: 'gpt-6-astra[1m]', effort: 'xhigh', fallback });
export const DEFAULT_MODELS = Object.freeze({
  plan: Object.freeze({ model: 'gpt-6-astra[1m]', effort: 'xhigh', fallback: 'claude-opus-5-5[1m]' }),
  'plan-review': Object.freeze({ model: 'claude-fable-5-1[1m]', effort: 'xhigh', fallback: 'claude-sonnet-5[1m]' }),
  implement: Object.freeze({ model: 'claude-opus-5-5[1m]', effort: null, fallback: 'claude-fable-5-1[1m]' }),
  fix: Object.freeze({ model: 'claude-opus-5-5[1m]', effort: null, fallback: 'claude-fable-5-1[1m]' }),
  simplify: Object.freeze({ model: 'claude-fable-5-1[1m]', effort: null, fallback: 'claude-opus-5-5[1m]' }),
  'diff-review': reviewer('claude-sonnet-5[1m]'),
  'code-review': reviewer('claude-sonnet-5[1m]'),
  'doubt-review': reviewer('claude-sonnet-5[1m]'),
});

// Who judges whose work: the plan's reviewer, and the code's three.
const JUDGED_BY = Object.freeze({
  plan: ['plan-review'],
  implement: ['diff-review', 'code-review', 'doubt-review'],
  fix: ['diff-review', 'code-review', 'doubt-review'],
  simplify: ['diff-review', 'code-review', 'doubt-review'],
});

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*(?:\[[A-Za-z0-9]+\])?$/u;

/** The same model however it is spelled: case, a context-window suffix, a
 *  vendor path or a gateway's vendor prefix, a release date. */
export function sameModel(left, right) {
  const norm = (id) => String(id ?? '').toLowerCase()
    .replace(/\[[^\]]*\]$/u, '')
    .replace(/^.*\//u, '')
    .replace(/^[a-z0-9]+-gateway-/u, '')
    .replace(/-\d{8}$/u, '');
  return left !== null && right !== null && left !== undefined && right !== undefined && norm(left) === norm(right);
}

export function globalConfigPath(env = process.env) {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'autoloop', 'config.json');
}

/** Problems with a (partial) models table: any subset of roles and fields. */
export function modelsShapeProblems(models, where) {
  if (models === null || typeof models !== 'object' || Array.isArray(models)) return [`${where}: models must be an object`];
  const problems = [];
  for (const [role, entry] of Object.entries(models)) {
    const at = `${where}: models.${role}`;
    if (!MODEL_ROLES.includes(role)) { problems.push(`${at}: unknown role (one of ${MODEL_ROLES.join(', ')})`); continue; }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) { problems.push(`${at}: must be an object`); continue; }
    for (const key of Object.keys(entry)) {
      if (!['model', 'effort', 'fallback'].includes(key)) problems.push(`${at}.${key}: unknown key (model, effort, fallback)`);
    }
    if ('model' in entry && !(typeof entry.model === 'string' && MODEL_ID.test(entry.model))) problems.push(`${at}.model: expected a model id`);
    if ('effort' in entry && entry.effort !== null && !EFFORTS.includes(entry.effort)) problems.push(`${at}.effort: one of ${EFFORTS.join(', ')}, or null`);
    if ('fallback' in entry && entry.fallback !== null && !(typeof entry.fallback === 'string' && MODEL_ID.test(entry.fallback))) {
      problems.push(`${at}.fallback: expected a model id, or null`);
    }
  }
  return problems;
}

/** Problems with the global file's whole shape. */
export function globalShapeProblems(value, where) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [`${where}: expected a JSON object`];
  const problems = Object.keys(value).filter((key) => !['version', 'models'].includes(key))
    .map((key) => `${where}: unknown key ${key} (the global file holds models only)`);
  if (value.version !== GLOBAL_CONFIG_VERSION) problems.push(`${where}: version must be "${GLOBAL_CONFIG_VERSION}"`);
  return [...problems, ...('models' in value ? modelsShapeProblems(value.models, where) : [])];
}

/** Later tables override earlier ones, per role and per field. */
export function mergeModels(...tables) {
  const merged = {};
  for (const role of MODEL_ROLES) {
    merged[role] = { model: null, effort: null, fallback: null };
    for (const table of tables) Object.assign(merged[role], table?.[role] ?? {});
  }
  return merged;
}

/** The pairs where a reviewer could run on its writer's model. */
export function invariantProblems(models) {
  const problems = [];
  for (const [writer, reviewers] of Object.entries(JUDGED_BY)) {
    const written = [models[writer].model, models[writer].fallback].filter(Boolean);
    for (const role of reviewers) {
      for (const judge of [models[role].model, models[role].fallback].filter(Boolean)) {
        const clash = written.find((model) => sameModel(model, judge));
        if (clash !== undefined) problems.push(`${role} could run on ${judge}, which ${writer} writes with (${clash})`);
      }
    }
  }
  return problems;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Writes the global file with the defaults when it is missing. Never
 *  overwrites; a lost race keeps the other writer's file. */
export function ensureGlobalConfig(path = globalConfigPath()) {
  if (existsSync(path)) return { created: false, error: null };
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, `${JSON.stringify({ version: GLOBAL_CONFIG_VERSION, models: DEFAULT_MODELS }, null, 2)}\n`);
    linkSync(temporary, path);
    return { created: true, error: null };
  } catch (error) {
    return existsSync(path) ? { created: false, error: null } : { created: false, error: error.message };
  } finally {
    try {
      rmSync(temporary, { force: true });
    } catch { /* its directory never existed */ }
  }
}

/** The resolved table: defaults ← global ← project. `projectModels` is the
 *  project config's `models` (already shape-checked by config-contract), or
 *  undefined. */
export function resolveModels({ projectModels, path = globalConfigPath(), create = true } = {}) {
  const ensured = create ? ensureGlobalConfig(path) : { created: false, error: null };
  let global = null;
  const problems = [];
  if (existsSync(path)) {
    try {
      global = readJson(path);
      problems.push(...globalShapeProblems(global, path));
    } catch (error) {
      problems.push(`${path}: ${error.message}`);
    }
  }
  if (projectModels !== undefined) problems.push(...modelsShapeProblems(projectModels, '.autoloop/config.json'));
  const source = { global: global === null ? null : path, created: ensured.created, globalError: ensured.error, project: projectModels !== undefined };
  if (problems.length > 0) return { ok: false, models: null, source, errors: problems };
  const models = mergeModels(DEFAULT_MODELS, global?.models, projectModels);
  const clashes = invariantProblems(models);
  return clashes.length > 0
    ? { ok: false, models: null, source, errors: clashes.map((clash) => `no artifact is judged by the model that wrote it: ${clash}`) }
    : { ok: true, models, source, errors: [] };
}

/** Pins the table a run resolved for its dispatches (prime writes it under
 *  the protected git dir): what prime reported is what every dispatch runs,
 *  and nothing a unit's branch or a mid-run edit changes moves it. */
export function pinModels(path, resolved) {
  if (!resolved?.ok) return false;
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ version: 1, models: resolved.models, source: resolved.source }, null, 1)}\n`);
  renameSync(temporary, path);
  return true;
}

/** The pinned table, re-checked: null when there is none, else {ok, models}
 *  or {ok:false, errors}. */
export function readPinnedModels(path) {
  let pinned;
  try {
    pinned = readJson(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return { ok: false, errors: [`${path}: ${error.message}`] };
  }
  const problems = pinned?.version === 1 ? modelsShapeProblems(pinned.models, path) : [`${path}: version must be 1`];
  if (problems.length > 0) return { ok: false, errors: problems };
  const models = mergeModels(DEFAULT_MODELS, pinned.models);
  const clashes = invariantProblems(models);
  return clashes.length > 0
    ? { ok: false, errors: clashes.map((clash) => `no artifact is judged by the model that wrote it: ${clash}`) }
    : { ok: true, models };
}

/** Session-start lines: where the table came from, and each role's model,
 *  effort and fallback (project overrides are prime's to report). */
export function modelLines(resolved) {
  if (!resolved.ok) return [`NOTE  step models refused: ${resolved.errors.join('; ')}`];
  const from = resolved.source.global ?? `built-in defaults (${resolved.source.globalError ?? 'no global file'})`;
  return [
    `INFO  step models from ${from} (project overrides: see prime)`,
    ...MODEL_ROLES.map((role) => {
      const { model, effort, fallback } = resolved.models[role];
      return `INFO    ${role} ${model}${effort ? ` !${effort}` : ''}${fallback ? ` > ${fallback}` : ''}`;
    }),
  ];
}

function selfTest() {
  const results = [];
  const check = (name, ok) => results.push([name, ok === true]);
  const scratch = mkdtempSync(join(tmpdir(), 'models-config-'));
  try {
    const path = join(scratch, 'claude', 'autoloop', 'config.json');
    check('the global path follows CLAUDE_CONFIG_DIR',
      globalConfigPath({ CLAUDE_CONFIG_DIR: '/c' }) === '/c/autoloop/config.json'
        && globalConfigPath({}) === join(homedir(), '.claude', 'autoloop', 'config.json'));
    const first = resolveModels({ path });
    const written = readJson(path);
    check('a missing global file is written with the defaults, and they resolve',
      first.ok === true && first.source.created === true
        && JSON.stringify(written) === JSON.stringify({ version: '1', models: DEFAULT_MODELS })
        && JSON.stringify(first.models) === JSON.stringify(mergeModels(DEFAULT_MODELS)));
    writeFileSync(path, JSON.stringify({ version: '1', models: { implement: { effort: 'high' } } }));
    const again = resolveModels({ path, projectModels: { implement: { model: 'claude-opus-5-5' } } });
    check('an existing file is never overwritten; global and project override per field',
      again.source.created === false && readJson(path).models.implement.effort === 'high'
        && again.models.implement.effort === 'high' && again.models.implement.model === 'claude-opus-5-5'
        && again.models.implement.fallback === 'claude-fable-5-1[1m]'
        && again.models.plan.model === 'gpt-6-astra[1m]');
    check('unknown keys, roles and efforts are refused',
      resolveModels({ path, projectModels: { implement: { modle: 'x' } } }).ok === false
        && resolveModels({ path, projectModels: { deploy: { model: 'x' } } }).ok === false
        && resolveModels({ path, projectModels: { plan: { effort: 'huge' } } }).ok === false
        && globalShapeProblems({ version: '1', models: {}, merge: {} }, 'g').length === 1
        && globalShapeProblems({ version: '2' }, 'g').length === 1);
    check('ids match across case, the window suffix and a gateway prefix',
      sameModel('gpt-6-astra[1m]', 'anthropic-gateway-GPT-6-Astra') && !sameModel('gpt-6-astra', 'gpt-6-sol')
        && !sameModel(null, null)
        // A vendor path and a dated id name the same model (review).
        && sameModel('anthropic/claude-opus-5-5', 'claude-opus-5-5[1m]')
        && sameModel('claude-opus-5-5-20260901', 'claude-opus-5-5')
        && !sameModel('claude-opus-5-5', 'claude-opus-5'));
    const clash = (models) => invariantProblems(mergeModels(DEFAULT_MODELS, models));
    check('the default table keeps every reviewer off its writer\'s models', clash({}).length === 0);
    check('a reviewer on its writer\'s model, primary or fallback, is refused and named',
      clash({ 'plan-review': { model: 'gpt-6-astra' } }).some((p) => p.startsWith('plan-review could run on gpt-6-astra, which plan'))
        && clash({ fix: { fallback: 'gpt-6-astra[1m]' } }).some((p) => p.includes('which fix writes with'))
        && clash({ 'doubt-review': { fallback: 'claude-fable-5-1' } }).some((p) => p.includes('which simplify writes with'))
        && clash({ simplify: { model: 'claude-sonnet-5' } }).length === 3
        && resolveModels({ path, projectModels: { 'code-review': { model: 'claude-opus-5-5[1m]' } } }).ok === false);
    check('the session-start lines name the source and each role\'s model, effort and fallback',
      (() => {
        const lines = modelLines(resolveModels({ path }));
        return lines[0] === `INFO  step models from ${path} (project overrides: see prime)` && lines.length === 1 + MODEL_ROLES.length
          && lines.includes('INFO    plan-review claude-fable-5-1[1m] !xhigh > claude-sonnet-5[1m]')
          && modelLines({ ok: false, errors: ['x: bad'] })[0] === 'NOTE  step models refused: x: bad';
      })());
    // Review of the model config: the table a run resolved is pinned for its
    // dispatches, so a writer editing its branch's config (or the global file)
    // cannot move its own reviewers.
    const pin = join(scratch, 'pin', 'models.json');
    const pinned = pinModels(pin, resolveModels({ path, projectModels: { implement: { effort: 'high' } } }));
    const readBack = readPinnedModels(pin);
    writeFileSync(pin, JSON.stringify({ version: 1, models: mergeModels(DEFAULT_MODELS, { 'code-review': { model: 'claude-opus-5-5' } }) }));
    const tampered = readPinnedModels(pin);
    check('a pinned table reads back as pinned, a missing one as absent, a clashing one as refused',
      pinned === true && readBack.ok === true && readBack.models.implement.effort === 'high'
        && readPinnedModels(join(scratch, 'none.json')) === null
        && tampered.ok === false && tampered.errors[0].includes('code-review could run on claude-opus-5-5'));
    writeFileSync(path, '{not json');
    check('an unreadable global file refuses, naming it',
      resolveModels({ path }).errors[0].startsWith(path));
    const readOnly = join(scratch, 'ro');
    writeFileSync(readOnly, 'a file, not a directory');
    const unwritable = resolveModels({ path: join(readOnly, 'autoloop', 'config.json') });
    check('a global file that cannot be written leaves the defaults in force, and says why',
      unwritable.ok === true && unwritable.source.globalError !== null && unwritable.source.global === null);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const failed = results.filter(([, ok]) => !ok);
  for (const [name] of failed) console.error(`FAIL ${name}`);
  console.log(failed.length === 0 ? `self-test OK (${results.length} cases)` : `self-test FAILED (${failed.length}/${results.length})`);
  return failed.length === 0;
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMain) {
  if (process.argv[2] === '--self-test') process.exit(selfTest() ? 0 : 1);
  const resolved = resolveModels();
  if (process.argv[2] === '--lines') {
    process.stdout.write(`${modelLines(resolved).join('\n')}\n`);
    process.exit(0);
  }
  process.stdout.write(`${JSON.stringify(resolved, null, 1)}\n`);
  process.exit(resolved.ok ? 0 : 1);
}
