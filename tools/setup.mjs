#!/usr/bin/env node
// autoloop — setup.mjs
//
// The mechanical half of autoloop:setup for the global install. A project
// carries only its own data (.autoloop/config.json, .autoloop/STATE.md, an
// optional checklist, docs/agentic/ARCH.md and LESSONS.md); every tool and hook
// runs from the plugin.
//
//   node <plugin-tools>/setup.mjs --init --root <repo> --base <branch> --gate <command>
//   node <plugin-tools>/setup.mjs --devendor --root <linked worktree> [--move-checklist]
//   node <plugin-tools>/setup.mjs --self-test
//
// The doctor is `verify.mjs --project-root <repo>`.
//
// --devendor converts a vendored (legacy) install once, in a linked worktree
// the skill made for its PR — never the session's own checkout: deleting the
// vendored guard under a live session trips its missing-file branch, which
// refuses every command until the session restarts.

import { spawnSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_VERSION, DEFAULT_CONFIG, LEGACY_STATE_FILE, PROJECT_CONFIG_FILE, repositoryRoot, resolveLegacyConfig,
  resolveProjectConfig, validateConfig,
} from './config-contract.mjs';
import { runsVendoredTool, vendoredLeftovers } from './hook-root.mjs';
import { hashValue } from './review-contract.mjs';

const TEMPLATES = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'templates');
const VENDORED_DIR = 'tools/agentic';
const SETTINGS_FILES = ['.claude/settings.json', '.claude/settings.local.json'];
const LEGACY_LOOP_FILE = 'docs/agentic/LOOP.md';
// Repository documents that may still point at the vendored layout.
const LEGACY_CHECKLIST = 'docs/agentic/checklist.md';
const CHECKLIST = '.autoloop/checklist.md';
const REFERENCE_FILES = ['CLAUDE.md', 'AGENTS.md', 'docs/agentic/ARCH.md', 'docs/agentic/LESSONS.md', LEGACY_CHECKLIST];
// A line that names the vendored layout: a shipped tool, the retired
// documents, or the word itself — never a repository's own file in tools/agentic.
const staleLine = (line) => runsVendoredTool(line) || /\bvendored\b|LOOP\.md|docs\/agentic\/STATE\.md/u.test(line);

function refusal(code, detail) {
  return { ok: false, code, detail };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readIfPresent(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function realOrSelf(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

// Devendor runs only in a linked worktree it can own: never the main
// checkout, and never the checkout this process or the session works in.
function worktreeProblem(root, cwd, projectDir) {
  const rev = (...args) => spawnSync('git', ['-C', root, 'rev-parse', ...args], { encoding: 'utf8' });
  const gitDir = rev('--absolute-git-dir');
  const common = rev('--git-common-dir');
  if (gitDir.status !== 0 || common.status !== 0) return refusal('NOT_A_WORKTREE', `${root} is not a git checkout`);
  const commonDir = resolve(root, common.stdout.trim());
  const top = realOrSelf(repositoryRoot(root));
  if (realOrSelf(gitDir.stdout.trim()) === realOrSelf(commonDir) || top !== realOrSelf(root)) {
    return refusal('NOT_A_WORKTREE', 'devendor runs at the top of a linked worktree made for its PR '
      + '(git worktree add), never the main checkout');
  }
  for (const dir of [cwd, projectDir]) {
    if (typeof dir === 'string' && dir !== '' && realOrSelf(repositoryRoot(dir)) === top) {
      return refusal('LIVE_CHECKOUT', 'devendor never runs in the checkout this session works in: removing '
        + 'the vendored guard there makes it refuse every command');
    }
  }
  return null;
}

// Every path devendor writes or removes must be a real path under the root:
// a symlinked component would carry the write or the deletion outside it.
function symlinkedComponent(root, path) {
  let current = root;
  for (const part of path.split('/')) {
    current = join(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      return null;
    }
    if (stat.isSymbolicLink()) return relative(root, current);
  }
  return null;
}

// The vendored policy, read by importing the vendored modules in a child
// process — so JavaScript decides what the arrays hold (multi-line literals,
// comments, spreads), not a pattern. These are the repository's own vendored
// tools, which its hooks ran on every command until now.
const READ_POLICY = `
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = process.argv[1];
const load = (name) => (existsSync(join(dir, name)) ? import(pathToFileURL(join(dir, name)).href) : null);
const lane = await load('lane-contract.mjs');
const escalate = await load('escalate-paths.mjs');
const executor = await load('auto-merge.mjs');
const structural = new Set(lane?.HUMAN_AUTHORIZATION_GLOBS ?? []);
process.stdout.write(JSON.stringify({
  escalate: (escalate?.ESCALATE_PATHS ?? []).filter((glob) => !structural.has(glob)),
  executor: executor === null ? null : {
    repository: executor.REPOSITORY ?? null,
    loopLogin: executor.LOOP_LOGIN ?? null,
    reversiblePaths: executor.REVERSIBLE_PATHS ?? [],
    extraProtectedPaths: executor.EXTRA_PROTECTED_PATHS ?? [],
  },
}));
`;

// Devendor runs the vendored policy code, so only the base's reviewed copy of
// it: tools/agentic must match the configured base (origin/<base>, else
// <base>) exactly, working tree included.
function vendoredPolicyProblem(root, baseBranch) {
  const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  const base = [`origin/${baseBranch}`, baseBranch]
    .find((ref) => git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`).status === 0);
  if (base === undefined) return refusal('VENDORED_POLICY_NOT_BASE', `the base ${baseBranch} does not resolve here`);
  const extra = git('status', '--porcelain', '--ignored', '--untracked-files=all', '--', VENDORED_DIR).stdout.trim();
  const hidden = git('ls-files', '-v', '--', VENDORED_DIR).stdout.split('\n').some((line) => /^(?:S|[a-z]) /u.test(line));
  return git('diff', '--quiet', base, '--', VENDORED_DIR).status === 0 && extra === '' && !hidden ? null
    : refusal('VENDORED_POLICY_NOT_BASE', `${VENDORED_DIR} differs from ${base} (changed, untracked or hidden files): `
      + `devendor runs only the base's reviewed vendored policy — recreate the worktree from ${base}`);
}

export function readVendoredPolicy(root) {
  // A minimal environment: no tokens or agent sockets. HOME stays (a module
  // may resolve paths from it), so this narrows exposure rather than removing it.
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', READ_POLICY, join(root, VENDORED_DIR)], {
    cwd: root, encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
  });
  try {
    if (run.status !== 0) throw new Error((run.stderr || run.error?.message || `exit ${run.status}`).trim().split('\n')[0]);
    return { ok: true, ...JSON.parse(run.stdout) };
  } catch (error) {
    return refusal('VENDORED_POLICY_UNREADABLE', `the vendored escalate/merge policy could not be read: ${error.message}`);
  }
}

// A Setup-filled executor's settings, or null for the placeholder block
// (which refused every invocation, so it never enforced anything).
function filledExecutor(executor) {
  if (executor === null || executor.repository?.owner === 'your-org') return null;
  return executor;
}

// What differs from the plugin defaults — the only thing config.json holds.
export function overridesOnly(value, defaults = DEFAULT_CONFIG) {
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!(key in defaults)) out[key] = entry;
    else if (isRecord(entry) && isRecord(defaults[key])) {
      const nested = overridesOnly(entry, defaults[key]);
      if (Object.keys(nested).length > 0) out[key] = nested;
    } else if (JSON.stringify(entry) !== JSON.stringify(defaults[key])) out[key] = entry;
  }
  return out;
}

// A hook handler setup vendored: it runs a vendored tool, or injects the
// legacy STATE (the plugin's preflight does both now).
function vendoredHandler(handler) {
  const command = String(handler?.command ?? '');
  return runsVendoredTool(command) || command.includes(LEGACY_STATE_FILE);
}

// Drops the vendored handlers and whatever they leave empty; null means the
// document held nothing else and the file goes.
export function withoutVendoredHooks(document) {
  const next = { ...document };
  const hooks = {};
  for (const [event, groups] of Object.entries(document?.hooks ?? {})) {
    const kept = (Array.isArray(groups) ? groups : [])
      .map((group) => ({ ...group, hooks: (group?.hooks ?? []).filter((handler) => !vendoredHandler(handler)) }))
      .filter((group) => group.hooks.length > 0);
    if (kept.length > 0) hooks[event] = kept;
  }
  if (Object.keys(hooks).length > 0) next.hooks = hooks;
  else delete next.hooks;
  return Object.keys(next).length === 0 ? null : next;
}

// Splits markdown into its preamble and `## ` sections.
function sections(markdown) {
  const parts = String(markdown).split(/^(?=## )/mu);
  return { preamble: parts[0], sections: parts.slice(1) };
}

// The legacy STATE's prose for .autoloop/STATE.md. The preamble and the
// `## Config` section were always the template's (they describe the retired
// config block, LOOP.md and the vendored tools), so they take the current
// template's text; every other section is the repository's and moves verbatim.
export function stateProse(markdown, template = readFileSync(join(TEMPLATES, 'STATE.template.md'), 'utf8')) {
  const legacy = sections(markdown);
  const current = sections(template);
  const isConfig = (section) => /^## Config\b/u.test(section);
  const config = current.sections.find(isConfig);
  const body = legacy.sections.map((section) => (isConfig(section) ? config ?? '' : section));
  return `${[current.preamble, ...body].join('')
    .replace(/```json[ \t]+autoloop-config[ \t]*\r?\n[\s\S]*?\r?\n```[ \t]*\r?\n?/u, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trimEnd()}\n`;
}

function removeEmptyDirectories(root, path) {
  const directory = join(root, path);
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) removeEmptyDirectories(root, `${path}/${entry.name}`);
  }
  try {
    rmdirSync(directory);
  } catch {
    // not empty: the repository's own files stay
  }
}

export function devendor(root, { cwd = process.cwd(), projectDir = process.env.CLAUDE_PROJECT_DIR, moveChecklist = false } = {}) {
  const place = worktreeProblem(root, cwd, projectDir);
  if (place !== null) return place;
  if (existsSync(join(root, PROJECT_CONFIG_FILE))) {
    return refusal('ALREADY_DEVENDORED', `${PROJECT_CONFIG_FILE} already exists`);
  }
  const legacy = resolveLegacyConfig(root);
  if (legacy === null) {
    return refusal('NOT_LEGACY', `no ${LEGACY_STATE_FILE} config block to convert`);
  }
  if (!legacy.ok) return refusal('LEGACY_CONFIG_INVALID', legacy.errors.join('; '));
  const written = [VENDORED_DIR, LEGACY_STATE_FILE, LEGACY_LOOP_FILE, ...SETTINGS_FILES, PROJECT_CONFIG_FILE, '.autoloop/STATE.md'];
  for (const path of moveChecklist ? [...written, LEGACY_CHECKLIST, CHECKLIST] : written) {
    const link = symlinkedComponent(root, path);
    if (link !== null) return refusal('SYMLINKED_PATH', `${link} is a symlink; devendor writes only real paths under the root`);
  }
  const drift = vendoredPolicyProblem(root, legacy.config.baseBranch);
  if (drift !== null) return drift;
  const policy = readVendoredPolicy(root);
  if (!policy.ok) return policy;

  const config = structuredClone(legacy.config);
  const executor = filledExecutor(policy.executor);
  const protectedPaths = [...new Set([
    ...(legacy.config.protectedPaths ?? []),
    ...policy.escalate,
    ...(executor?.extraProtectedPaths ?? []),
  ])];
  if (protectedPaths.length > 0) config.protectedPaths = protectedPaths;
  if (executor !== null && config.merge.policy !== 'manual') {
    if (typeof executor.loopLogin === 'string') config.merge.loopLogin = executor.loopLogin;
    if (JSON.stringify(executor.reversiblePaths) !== JSON.stringify(['docs/**'])) {
      config.merge.reversiblePaths = executor.reversiblePaths;
    }
  }
  // Offered (the human decides): the legacy checklist joins .autoloop/, where
  // the default path already points, so config no longer names it. A move
  // that cannot happen is refused, never dropped.
  if (moveChecklist) {
    const unmovable = config.review.checklistPath !== LEGACY_CHECKLIST
      ? `the configured checklist is ${config.review.checklistPath}, not ${LEGACY_CHECKLIST}`
      : !existsSync(join(root, LEGACY_CHECKLIST)) ? `${LEGACY_CHECKLIST} does not exist`
        : existsSync(join(root, CHECKLIST)) ? `${CHECKLIST} already exists` : null;
    if (unmovable !== null) return refusal('CHECKLIST_NOT_MOVABLE', unmovable);
    config.review.checklistPath = CHECKLIST;
  }
  const errors = validateConfig(config);
  if (errors.length > 0) return refusal('DEVENDOR_CONFIG_INVALID', errors.join('; '));
  const gateOnVendoredTool = ['command', 'quickCommand', 'setupCommand']
    .map((key) => config.gate[key]).find((command) => runsVendoredTool(command));
  if (gateOnVendoredTool !== undefined) {
    return refusal('GATE_USES_VENDORED_TOOL', `the gate runs a vendored tool devendor removes: \`${gateOnVendoredTool}\``);
  }

  // Settings first: an unreadable file is refused before anything is written.
  const settings = [];
  for (const file of SETTINGS_FILES) {
    const text = readIfPresent(join(root, file));
    if (text === null) continue;
    let document;
    try {
      document = JSON.parse(text);
    } catch (error) {
      return refusal('SETTINGS_UNREADABLE', `${file}: ${error.message}`);
    }
    const next = withoutVendoredHooks(document);
    if (JSON.stringify(next) !== JSON.stringify(document)) settings.push({ file, next });
  }

  // config.json holds only overrides, and must resolve to exactly this config
  // (the review fingerprint and every reader depend on it).
  mkdirSync(join(root, '.autoloop'), { recursive: true });
  writeFileSync(join(root, PROJECT_CONFIG_FILE), `${JSON.stringify(overridesOnly(config), null, 2)}\n`);
  const resolved = resolveProjectConfig(root);
  if (!resolved?.ok || hashValue(resolved.config) !== hashValue(config)) {
    rmSync(join(root, '.autoloop'), { recursive: true, force: true });
    return refusal('DEVENDOR_ROUNDTRIP', 'the written overrides do not resolve to the converted config');
  }
  if (moveChecklist) renameSync(join(root, LEGACY_CHECKLIST), join(root, CHECKLIST));
  const prose = stateProse(readFileSync(join(root, LEGACY_STATE_FILE), 'utf8'));
  writeFileSync(join(root, '.autoloop', 'STATE.md'), prose);

  const removed = [LEGACY_STATE_FILE];
  rmSync(join(root, LEGACY_STATE_FILE));
  if (existsSync(join(root, LEGACY_LOOP_FILE))) {
    rmSync(join(root, LEGACY_LOOP_FILE));
    removed.push(LEGACY_LOOP_FILE);
  }
  for (const name of vendoredLeftovers(root).files) {
    rmSync(join(root, VENDORED_DIR, name));
    removed.push(`${VENDORED_DIR}/${name}`);
  }
  removeEmptyDirectories(root, 'tools');
  const kept = existsSync(join(root, VENDORED_DIR))
    ? readdirSync(join(root, VENDORED_DIR), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(root, join(entry.parentPath ?? entry.path, entry.name)).split(sep).join('/'))
    : [];
  const settingsActions = settings.map(({ file, next }) => {
    if (next === null) {
      rmSync(join(root, file));
      return { file, action: 'removed' };
    }
    writeFileSync(join(root, file), `${JSON.stringify(next, null, 2)}\n`);
    return { file, action: 'vendored hooks removed' };
  });
  // After a move the checklist is read at its new path, and a line naming its
  // old one is stale too.
  const stale = moveChecklist ? (line) => staleLine(line) || line.includes(LEGACY_CHECKLIST) : staleLine;
  const staleReferences = REFERENCE_FILES.map((file) => (moveChecklist && file === LEGACY_CHECKLIST ? CHECKLIST : file))
    .flatMap((file) => (readIfPresent(join(root, file)) ?? '')
      .split('\n').filter(stale).map((line) => `${file}: ${line.trim()}`));
  return {
    ok: true,
    config,
    removed,
    movedChecklist: moveChecklist,
    // The repository's own files under tools/agentic/ (a gate script): kept.
    kept,
    settings: settingsActions,
    // A review chain binds the config's fingerprint: an open loop PR reviewed
    // before this lands needs its review re-run.
    fingerprintChanged: hashValue(config) !== hashValue(legacy.config),
    // The repository's own lines that still name the vendored layout: its
    // prose to edit, never setup's to rewrite.
    staleProse: prose.split('\n').filter(stale),
    staleReferences,
  };
}

export function init(root, { base, gate }) {
  if (existsSync(join(root, PROJECT_CONFIG_FILE))) return refusal('ALREADY_CONFIGURED', `${PROJECT_CONFIG_FILE} exists`);
  if (existsSync(join(root, LEGACY_STATE_FILE))) {
    return refusal('LEGACY_INSTALL', `${LEGACY_STATE_FILE} exists: run --devendor in a worktree instead`);
  }
  const config = { version: CONFIG_VERSION, baseBranch: base, gate: { command: gate } };
  const errors = validateConfig({
    ...config,
    gate: { ...config.gate, quickCommand: null, setupCommand: null },
    merge: { policy: 'manual' },
    tracker: { provider: 'none' },
    review: { checklistPath: '.autoloop/checklist.md' },
  });
  if (errors.length > 0) return refusal('CONFIG_INVALID', errors.join('; '));
  const written = [];
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
    written.push(path);
  };
  write(PROJECT_CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
  write('.autoloop/STATE.md', readFileSync(join(TEMPLATES, 'STATE.template.md'), 'utf8'));
  for (const [path, template] of [['docs/agentic/ARCH.md', 'ARCH.template.md'], ['docs/agentic/LESSONS.md', 'LESSONS.template.md']]) {
    if (!existsSync(join(root, path))) write(path, readFileSync(join(TEMPLATES, template), 'utf8'));
  }
  return { ok: true, config, written };
}

async function selfTest() {
  const failures = [];
  const cases = [];
  const check = (name, passed) => {
    cases.push(name);
    if (!passed) failures.push(name);
  };
  const { activeAutoloopRoot } = await import('./hook-root.mjs');
  const { settingsFromConfig } = await import('./auto-merge.mjs');
  const { escalatePathsFor, matchEscalate } = await import('./escalate-paths.mjs');
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'autoloop-setup-')));
  const doctor = (root) => spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'verify.mjs'), '--project-root', root], {
    encoding: 'utf8',
  });
  const write = (root, path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const git = (root, ...args) => spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    encoding: 'utf8',
  });
  const away = { cwd: scratch, projectDir: '' };
  try {
    // A filled, vendored, non-manual install shaped like the live ones: an
    // importable vendored policy (a multi-line array, a commented-out entry,
    // a block comment inside an array), a repository-owned gate script under
    // tools/agentic, a legacy protected path, and settings with a user hook.
    const legacyConfig = {
      version: CONFIG_VERSION,
      baseBranch: 'main',
      gate: { command: 'node tools/agentic/gate.mjs', quickCommand: null, setupCommand: null },
      merge: { policy: 'auto', unverifiedInvocationAcknowledged: true, soloOperatorAcknowledged: true },
      tracker: { provider: 'none' },
      review: { checklistPath: 'docs/agentic/checklist.md' },
      protectedPaths: ['payments/**'],
    };
    const legacyWorktree = (name, { executor = true, config = legacyConfig, extra = () => {} } = {}) => {
      const main = join(scratch, name);
      mkdirSync(main);
      git(main, 'init', '-q', '-b', 'main');
      write(main, LEGACY_STATE_FILE, [
        '# STATE — autoloop standing config & policy', '', '> Not the task queue (see [`LOOP.md`](./LOOP.md)).', '',
        '## Mission', '', 'Keep the engine honest.', '', '## Config (the single machine-readable config surface)', '',
        'Skills and the vendored `tools/agentic/*` scripts read this block.', '',
        '```json autoloop-config', JSON.stringify(config, null, 2), '```', '', '- `version` — the schema.', '',
        '## Protected ground', '', '- spec/', '', '## Playbooks', '', 'Run `node tools/agentic/escalate-paths.mjs` first.', '',
      ].join('\n'));
      write(main, LEGACY_LOOP_FILE, '# LOOP\n');
      write(main, 'docs/agentic/checklist.md', '# checklist\n');
      write(main, 'docs/agentic/ARCH.md', '# ARCH\n');
      write(main, 'CLAUDE.md', 'Gate: `node tools/agentic/gate.mjs`.\nPrime with `node tools/agentic/prime.mjs --json`.\n');
      write(main, `${VENDORED_DIR}/gate.mjs`, '// the repository\'s own gate\n');
      write(main, `${VENDORED_DIR}/briefs/plan.md`, '# plan brief\n');
      write(main, `${VENDORED_DIR}/prime.mjs`, '// vendored\n');
      write(main, `${VENDORED_DIR}/lane-contract.mjs`, "export const HUMAN_AUTHORIZATION_GLOBS = ['.env*'];\n");
      write(main, `${VENDORED_DIR}/escalate-paths.mjs`, [
        "import { HUMAN_AUTHORIZATION_GLOBS } from './lane-contract.mjs';",
        'export const ESCALATE_PATHS = [', '  ...HUMAN_AUTHORIZATION_GLOBS,', "  // 'src/auth/**',",
        "  'spec/**', /* , '**' */", "  'compose.y*ml',", "  '**/compose.y*ml',", '];', '',
      ].join('\n'));
      if (executor) {
        write(main, `${VENDORED_DIR}/auto-merge.mjs`, [
          "export const REPOSITORY = { owner: 'acme', name: 'app' };",
          "export const REVERSIBLE_PATHS = ['docs/**' /* , '**' */];",
          'export const EXTRA_PROTECTED_PATHS = [', "  'spec/**',", "  'infra/**',", '];',
          "export const LOOP_LOGIN = 'loop-user';", '',
        ].join('\n'));
      }
      write(main, '.claude/settings.json', JSON.stringify({
        permissions: { allow: ['Bash(npm test)'] },
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [
            { type: 'command', command: 's="$CLAUDE_PROJECT_DIR/tools/agentic/command-guard.mjs"; node "$s"' },
            { type: 'command', command: 'echo user-hook' },
          ] }],
          SessionStart: [{ hooks: [{ type: 'command', command: 'cat "$CLAUDE_PROJECT_DIR/docs/agentic/STATE.md"' }] }],
        },
      }, null, 2));
      extra(main);
      git(main, 'add', '-A');
      git(main, 'commit', '-q', '-m', 'legacy install');
      const worktree = join(scratch, `${name}-devendor`);
      git(main, 'worktree', 'add', '-q', '-b', 'autoloop/devendor', worktree);
      return { main, worktree };
    };

    const { main: repo, worktree } = legacyWorktree('repo');
    check('devendor refuses the main checkout, and the checkout this session works in',
      devendor(repo, away).code === 'NOT_A_WORKTREE' && devendor(worktree, { cwd: worktree, projectDir: '' }).code === 'LIVE_CHECKOUT'
        && devendor(worktree, { cwd: scratch, projectDir: join(worktree, 'docs') }).code === 'LIVE_CHECKOUT'
        && existsSync(join(worktree, VENDORED_DIR, 'prime.mjs')));
    const result = devendor(worktree, away);
    const written = JSON.parse(readIfPresent(join(worktree, PROJECT_CONFIG_FILE)) ?? 'null');
    check('devendor converts the vendored policy as JavaScript reads it, keeping the legacy protected paths',
      result.ok === true
        && JSON.stringify(result.config.protectedPaths) === '["payments/**","spec/**","compose.y*ml","**/compose.y*ml","infra/**"]'
        && result.config.merge.loopLogin === 'loop-user' && result.config.merge.reversiblePaths === undefined
        && result.fingerprintChanged === true);
    check('config.json holds only overrides and resolves to exactly the converted config',
      written !== null && written.tracker === undefined && written.gate.quickCommand === undefined
        && written.review.checklistPath === 'docs/agentic/checklist.md'
        && hashValue(resolveProjectConfig(worktree).config) === hashValue(result.config));
    check('only shipped files go; the repository\'s own gate script stays and is reported',
      !existsSync(join(worktree, VENDORED_DIR, 'prime.mjs')) && !existsSync(join(worktree, VENDORED_DIR, 'briefs'))
        && existsSync(join(worktree, VENDORED_DIR, 'gate.mjs')) && JSON.stringify(result.kept) === '["tools/agentic/gate.mjs"]'
        && !existsSync(join(worktree, LEGACY_LOOP_FILE)) && !existsSync(join(worktree, LEGACY_STATE_FILE)));
    const settings = JSON.parse(readIfPresent(join(worktree, '.claude/settings.json')) ?? 'null');
    check('devendor leaves only the repository\'s own settings and hooks',
      JSON.stringify(settings) === JSON.stringify({
        permissions: { allow: ['Bash(npm test)'] },
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-hook' }] }] },
      }));
    const prose = readIfPresent(join(worktree, '.autoloop', 'STATE.md')) ?? '';
    check('the STATE prose moves with the current template\'s preamble and Config section',
      prose.includes('Keep the engine honest.') && prose.includes('## Protected ground\n\n- spec/')
        && !prose.includes('autoloop-config') && !prose.includes('LOOP.md')
        && prose.includes('`.autoloop/config.json` holds only what differs') && prose.startsWith('# STATE — autoloop standing policy'));
    check('repository prose and documents that still name the vendored layout are reported, not rewritten',
      JSON.stringify(result.staleProse) === JSON.stringify(['Run `node tools/agentic/escalate-paths.mjs` first.'])
        && JSON.stringify(result.staleReferences) === JSON.stringify(['CLAUDE.md: Prime with `node tools/agentic/prime.mjs --json`.'])
        && prose.includes('Run `node tools/agentic/escalate-paths.mjs` first.'));
    const executorSettings = settingsFromConfig(result.config, { owner: 'acme', name: 'app' });
    check('the result is a devendored repository the plugin hooks, doctor, escalation and executor accept',
      activeAutoloopRoot(worktree) === worktree && doctor(worktree).status === 0
        && matchEscalate(['spec/rules.md', 'deploy/compose.yml', 'payments/x.ts'], escalatePathsFor(worktree).paths).length === 3
        && executorSettings.error === null && executorSettings.AUTOMERGE_MODE === 'all-green'
        && executorSettings.SOLO_OPERATOR === true);
    check('devendor runs once', devendor(worktree, away).code === 'ALREADY_DEVENDORED');

    // Offered at devendor: the legacy checklist joins the rest of the
    // repository's autoloop data, and config stops naming its path.
    const { worktree: moved } = legacyWorktree('moved', {
      extra: (main) => {
        write(main, 'docs/agentic/checklist.md', '# checklist\nRun the vendored gate.\n');
        write(main, 'docs/agentic/ARCH.md', '# ARCH\nReviewers read docs/agentic/checklist.md.\n');
      },
    });
    const movedResult = devendor(moved, { ...away, moveChecklist: true });
    const movedConfig = JSON.parse(readIfPresent(join(moved, PROJECT_CONFIG_FILE)) ?? 'null');
    check('--move-checklist moves the checklist into .autoloop and drops the path override',
      movedResult.ok === true && movedResult.movedChecklist === true
        && existsSync(join(moved, '.autoloop', 'checklist.md')) && !existsSync(join(moved, 'docs/agentic/checklist.md'))
        && movedConfig?.review === undefined && resolveProjectConfig(moved)?.config.review.checklistPath === '.autoloop/checklist.md'
        && doctor(moved).status === 0 && result.movedChecklist === false);
    check('after a move the checklist is scanned at its new path, and lines naming its old one are stale',
      movedResult.staleReferences.includes('.autoloop/checklist.md: Run the vendored gate.')
        && movedResult.staleReferences.includes('docs/agentic/ARCH.md: Reviewers read docs/agentic/checklist.md.'));
    const { worktree: blocked } = legacyWorktree('blocked', {
      extra: (main) => write(main, '.autoloop/checklist.md', '# already here\n'),
    });
    const blockedResult = devendor(blocked, { ...away, moveChecklist: true });
    check('a checklist move that cannot happen is refused before anything is written',
      blockedResult.code === 'CHECKLIST_NOT_MOVABLE' && blockedResult.detail.includes('already exists')
        && !existsSync(join(blocked, PROJECT_CONFIG_FILE)) && existsSync(join(blocked, LEGACY_STATE_FILE)));

    const { worktree: manual } = legacyWorktree('manual', {
      executor: false,
      config: { ...legacyConfig, merge: { policy: 'manual' }, protectedPaths: undefined },
      extra: (main) => rmSync(join(main, VENDORED_DIR, 'escalate-paths.mjs')),
    });
    const manualResult = devendor(manual, away);
    check('a manual install with no repository entries keeps its config exactly',
      manualResult.ok === true && manualResult.fingerprintChanged === false
        && manualResult.config.protectedPaths === undefined && manualResult.config.merge.loopLogin === undefined);

    const { worktree: broken } = legacyWorktree('broken', { extra: (main) => write(main, '.claude/settings.json', '{ not json') });
    check('unreadable settings refuse before anything is written',
      devendor(broken, away).code === 'SETTINGS_UNREADABLE'
        && existsSync(join(broken, VENDORED_DIR, 'prime.mjs')) && !existsSync(join(broken, PROJECT_CONFIG_FILE)));

    const outside = join(scratch, 'outside');
    mkdirSync(join(outside, 'agentic'), { recursive: true });
    writeFileSync(join(outside, 'agentic', 'prime.mjs'), '// not the repository\'s\n');
    const { worktree: linked } = legacyWorktree('linked', {
      extra: (main) => {
        rmSync(join(main, 'tools'), { recursive: true, force: true });
        spawnSync('ln', ['-s', outside, join(main, 'tools')]);
      },
    });
    check('a symlinked path refuses, and nothing outside the root is touched',
      devendor(linked, away).code === 'SYMLINKED_PATH' && existsSync(join(outside, 'agentic', 'prime.mjs')));

    const { worktree: vendoredGate } = legacyWorktree('vendored-gate', {
      config: { ...legacyConfig, gate: { ...legacyConfig.gate, command: 'node tools/agentic/verify.mjs --project-root .' } },
    });
    check('a gate that runs a shipped vendored tool refuses',
      devendor(vendoredGate, away).code === 'GATE_USES_VENDORED_TOOL');

    const { worktree: unreadablePolicy } = legacyWorktree('unreadable-policy', {
      extra: (main) => write(main, `${VENDORED_DIR}/escalate-paths.mjs`, 'export const ESCALATE_PATHS = [ ...MISSING ];\n'),
    });
    check('a vendored policy that cannot be read refuses instead of guessing',
      devendor(unreadablePolicy, away).code === 'VENDORED_POLICY_UNREADABLE');

    // Devendor runs the vendored policy code, so only the base's reviewed copy:
    // a worktree whose tools/agentic differs from the base refuses.
    const { worktree: drifted } = legacyWorktree('drifted');
    writeFileSync(join(drifted, VENDORED_DIR, 'escalate-paths.mjs'), "export const ESCALATE_PATHS = ['**'];\n");
    check('a worktree whose vendored policy differs from the base refuses before running it',
      devendor(drifted, away).code === 'VENDORED_POLICY_NOT_BASE' && !existsSync(join(drifted, PROJECT_CONFIG_FILE)));
    const { worktree: untracked } = legacyWorktree('untracked');
    writeFileSync(join(untracked, VENDORED_DIR, 'auto-merge.extra.mjs'), 'export {};\n');
    const { worktree: hidden } = legacyWorktree('hidden');
    git(hidden, 'update-index', '--skip-worktree', `${VENDORED_DIR}/escalate-paths.mjs`);
    check('an untracked or skip-worktree file under tools/agentic refuses too',
      devendor(untracked, away).code === 'VENDORED_POLICY_NOT_BASE' && devendor(hidden, away).code === 'VENDORED_POLICY_NOT_BASE');

    const fresh = join(scratch, 'fresh');
    mkdirSync(fresh);
    write(fresh, 'docs/agentic/ARCH.md', '# existing ARCH\n');
    const initialized = init(fresh, { base: 'main', gate: 'npm test' });
    check('init writes overrides only, seeds what is missing, and keeps what exists',
      initialized.ok === true
        && JSON.stringify(JSON.parse(readFileSync(join(fresh, PROJECT_CONFIG_FILE), 'utf8')))
          === JSON.stringify({ version: CONFIG_VERSION, baseBranch: 'main', gate: { command: 'npm test' } })
        && existsSync(join(fresh, '.autoloop', 'STATE.md')) && existsSync(join(fresh, 'docs/agentic/LESSONS.md'))
        && readFileSync(join(fresh, 'docs/agentic/ARCH.md'), 'utf8') === '# existing ARCH\n'
        && resolveProjectConfig(fresh)?.ok === true && doctor(fresh).status === 0);
    check('init refuses a configured or a legacy repository',
      init(fresh, { base: 'main', gate: 'x' }).code === 'ALREADY_CONFIGURED'
        && init(repo, { base: 'main', gate: 'x' }).code === 'LEGACY_INSTALL');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  for (const name of failures) console.error(`FAIL ${name}`);
  console.log(failures.length === 0
    ? `self-test OK (${cases.length} cases)`
    : `self-test FAILED (${failures.length}/${cases.length})`);
  return failures.length === 0;
}

function flag(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] ?? null;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) process.exit((await selfTest()) ? 0 : 1);
  const root = flag(args, '--root');
  let result;
  if (args.includes('--devendor') && root) result = devendor(resolve(root), { moveChecklist: args.includes('--move-checklist') });
  else if (args.includes('--init') && root && flag(args, '--base') && flag(args, '--gate')) {
    result = init(resolve(root), { base: flag(args, '--base'), gate: flag(args, '--gate') });
  } else {
    console.error('usage: setup.mjs --init --root <repo> --base <branch> --gate <command> | --devendor --root <worktree> [--move-checklist] | --self-test');
    process.exit(2);
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMain) await main();
