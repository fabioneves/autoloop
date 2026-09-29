#!/usr/bin/env node
// autoloop — setup.mjs
//
// The mechanical half of autoloop:setup for the global install. A project
// carries only its own data (.autoloop/config.json, .autoloop/STATE.md, an
// optional checklist, docs/agentic/ARCH.md and LESSONS.md); every tool and hook
// runs from the plugin.
//
//   node <plugin-tools>/setup.mjs --init --root <repo> --base <branch> --gate <command>
//   node <plugin-tools>/setup.mjs --devendor --root <worktree>
//   node <plugin-tools>/setup.mjs --self-test
//
// The doctor is `verify.mjs --project-root <repo>`.
//
// --devendor converts a vendored (legacy) install, once, in a worktree the
// skill made for its PR — never the session's own checkout: deleting
// tools/agentic/ under a live session trips the vendored guard's missing-file
// branch, which refuses every command until the session restarts.

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_VERSION, LEGACY_STATE_FILE, PROJECT_CONFIG_FILE, resolveProjectConfig, validateConfig,
} from './config-contract.mjs';
import { hashValue } from './review-contract.mjs';

const TEMPLATES = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDORED_TOOLS = 'tools/agentic';
const SETTINGS_FILES = ['.claude/settings.json', '.claude/settings.local.json'];
const PLACEHOLDER_OWNER = "owner: 'your-org'";

function refusal(code, detail) {
  return { ok: false, code, detail };
}

function samePath(left, right) {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

function readIfPresent(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function stringLiterals(text) {
  return [...text.matchAll(/'([^'\n]*)'|"([^"\n]*)"/gu)].map((match) => match[1] ?? match[2]);
}

function withoutLineComments(text) {
  return text.split('\n').map((line) => line.replace(/\/\/.*$/u, '')).join('\n');
}

// The repository's own entries in a vendored escalate-paths.mjs: the string
// literals of ESCALATE_PATHS (the structural families are spread in, and the
// template's examples are commented out).
export function vendoredEscalateEntries(source) {
  const match = /export const ESCALATE_PATHS = \[([\s\S]*?)\];/u.exec(source ?? '');
  return match === null ? [] : stringLiterals(withoutLineComments(match[1]));
}

// The repository settings of a Setup-filled merge executor, or null for the
// placeholder block (which never enforced anything).
export function filledExecutorSettings(source) {
  if (source === null || source.includes(PLACEHOLDER_OWNER)) return null;
  const array = (name) => {
    const match = new RegExp(`^export const ${name} = (\\[[^\\n]*\\]);`, 'mu').exec(source);
    return match === null ? [] : stringLiterals(withoutLineComments(match[1]));
  };
  return {
    loopLogin: /^export const LOOP_LOGIN = '([^']*)';/mu.exec(source)?.[1] ?? null,
    reversiblePaths: array('REVERSIBLE_PATHS'),
    extraProtectedPaths: array('EXTRA_PROTECTED_PATHS'),
  };
}

// A hook handler setup vendored: it runs a tools/agentic tool, or injects the
// legacy STATE (the plugin's preflight does both now).
function vendoredHandler(handler) {
  const command = String(handler?.command ?? '');
  return command.includes(`${VENDORED_TOOLS}/`) || command.includes(LEGACY_STATE_FILE);
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

export function stateProse(markdown) {
  return `${String(markdown)
    .replace(/```json[ \t]+autoloop-config[ \t]*\r?\n[\s\S]*?\r?\n```[ \t]*\r?\n?/u, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trimEnd()}\n`;
}

export function devendor(root, { projectDir = process.env.CLAUDE_PROJECT_DIR } = {}) {
  if (typeof projectDir === 'string' && projectDir !== '' && samePath(root, projectDir)) {
    return refusal('LIVE_CHECKOUT', 'devendor runs in a separate worktree for its PR, never the session\'s own '
      + 'checkout: removing tools/agentic/ here makes the vendored guard refuse every command');
  }
  if (existsSync(join(root, PROJECT_CONFIG_FILE))) {
    return refusal('ALREADY_DEVENDORED', `${PROJECT_CONFIG_FILE} already exists`);
  }
  const legacy = resolveProjectConfig(root);
  if (legacy === null || legacy.source !== LEGACY_STATE_FILE) {
    return refusal('NOT_LEGACY', `no ${LEGACY_STATE_FILE} config block to convert`);
  }
  if (!legacy.ok) return refusal('LEGACY_CONFIG_INVALID', legacy.errors.join('; '));

  const config = structuredClone(legacy.config);
  const executor = filledExecutorSettings(readIfPresent(join(root, VENDORED_TOOLS, 'auto-merge.mjs')));
  const protectedPaths = [...new Set([
    ...vendoredEscalateEntries(readIfPresent(join(root, VENDORED_TOOLS, 'escalate-paths.mjs'))),
    ...(executor?.extraProtectedPaths ?? []),
  ])];
  if (protectedPaths.length > 0) config.protectedPaths = protectedPaths;
  if (executor !== null && config.merge.policy !== 'manual') {
    if (executor.loopLogin !== null) config.merge.loopLogin = executor.loopLogin;
    if (JSON.stringify(executor.reversiblePaths) !== JSON.stringify(['docs/**'])) {
      config.merge.reversiblePaths = executor.reversiblePaths;
    }
  }
  const errors = validateConfig(config);
  if (errors.length > 0) return refusal('DEVENDOR_CONFIG_INVALID', errors.join('; '));

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
    if (JSON.stringify(next) === JSON.stringify(document)) continue;
    settings.push({ file, next });
  }

  mkdirSync(join(root, '.autoloop'), { recursive: true });
  writeFileSync(join(root, PROJECT_CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(join(root, '.autoloop', 'STATE.md'), stateProse(readFileSync(join(root, LEGACY_STATE_FILE), 'utf8')));
  const removed = [LEGACY_STATE_FILE];
  rmSync(join(root, LEGACY_STATE_FILE));
  for (const path of [VENDORED_TOOLS, 'docs/agentic/LOOP.md']) {
    if (!existsSync(join(root, path))) continue;
    rmSync(join(root, path), { recursive: true, force: true });
    removed.push(path);
  }
  const settingsActions = settings.map(({ file, next }) => {
    if (next === null) {
      rmSync(join(root, file));
      return { file, action: 'removed' };
    }
    writeFileSync(join(root, file), `${JSON.stringify(next, null, 2)}\n`);
    return { file, action: 'vendored hooks removed' };
  });
  return {
    ok: true,
    config,
    removed,
    settings: settingsActions,
    // A review chain binds the config's fingerprint: an open loop PR reviewed
    // before this lands needs its review re-run.
    fingerprintChanged: hashValue(config) !== hashValue(legacy.config),
  };
}

export function init(root, { base, gate }) {
  if (existsSync(join(root, PROJECT_CONFIG_FILE))) return refusal('ALREADY_CONFIGURED', `${PROJECT_CONFIG_FILE} exists`);
  if (existsSync(join(root, LEGACY_STATE_FILE))) {
    return refusal('LEGACY_INSTALL', `${LEGACY_STATE_FILE} exists: run --devendor in a worktree instead`);
  }
  const config = { version: CONFIG_VERSION, baseBranch: base, gate: { command: gate } };
  const resolved = { ...config, gate: { ...config.gate, quickCommand: null, setupCommand: null } };
  const errors = validateConfig({
    ...resolved, merge: { policy: 'manual' }, tracker: { provider: 'none' }, review: { checklistPath: '.autoloop/checklist.md' },
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
  const { settingsFromConfig } = await import('./auto-merge.reference.mjs');
  const { escalatePathsFor, matchEscalate } = await import('./escalate-paths.mjs');
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'autoloop-setup-')));
  const doctor = (root) => spawnSync(process.execPath, [join(TEMPLATES, 'tools', 'verify.mjs'), '--project-root', root], {
    encoding: 'utf8',
  });
  const write = (root, path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  try {
    // A filled, vendored, non-manual install shaped like a live one.
    const legacyConfig = {
      version: CONFIG_VERSION,
      baseBranch: 'main',
      gate: { command: 'npm test', quickCommand: null, setupCommand: null },
      merge: { policy: 'auto', unverifiedInvocationAcknowledged: true, soloOperatorAcknowledged: true },
      tracker: { provider: 'none' },
      review: { checklistPath: 'docs/agentic/checklist.md' },
    };
    const legacyInstall = (root, { executor = true, config = legacyConfig } = {}) => {
      write(root, LEGACY_STATE_FILE, [
        '# STATE', '', '## Mission', '', 'Keep the engine honest.', '', '## Config', '',
        '```json autoloop-config', JSON.stringify(config, null, 2), '```', '', '## Protected ground', '', '- spec/', '',
      ].join('\n'));
      write(root, 'docs/agentic/LOOP.md', '# LOOP\n');
      write(root, 'docs/agentic/checklist.md', '# checklist\n');
      write(root, 'docs/agentic/ARCH.md', '# ARCH\n');
      write(root, `${VENDORED_TOOLS}/escalate-paths.mjs`, [
        'export const ESCALATE_PATHS = [', '  ...HUMAN_AUTHORIZATION_GLOBS,', "  // 'src/auth/**',",
        "  'spec/**',", "  'compose.y*ml',", "  '**/compose.y*ml',", '];', '',
      ].join('\n'));
      if (executor) {
        write(root, `${VENDORED_TOOLS}/auto-merge.mjs`, [
          "export const REPOSITORY = { owner: 'acme', name: 'app' };",
          "export const REVERSIBLE_PATHS = ['docs/**'];",
          "export const EXTRA_PROTECTED_PATHS = ['spec/**', 'infra/**'];",
          "export const LOOP_LOGIN = 'loop-user';", '',
        ].join('\n'));
      }
      write(root, '.claude/settings.json', JSON.stringify({
        permissions: { allow: ['Bash(npm test)'] },
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [
            { type: 'command', command: 's="$CLAUDE_PROJECT_DIR/tools/agentic/command-guard.mjs"; node "$s"' },
            { type: 'command', command: 'echo user-hook' },
          ] }],
          SessionStart: [{ hooks: [{ type: 'command', command: 'cat "$CLAUDE_PROJECT_DIR/docs/agentic/STATE.md"' }] }],
        },
      }, null, 2));
      write(root, '.claude/settings.local.json', JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/tools/agentic/writeback-check.mjs"' }] }] },
      }));
    };

    const repo = join(scratch, 'repo');
    legacyInstall(repo);
    check('devendor refuses the session\'s own checkout',
      devendor(repo, { projectDir: repo }).code === 'LIVE_CHECKOUT' && existsSync(join(repo, VENDORED_TOOLS)));
    const result = devendor(repo, { projectDir: join(scratch, 'elsewhere') });
    const config = JSON.parse(readIfPresent(join(repo, PROJECT_CONFIG_FILE)) ?? 'null');
    check('devendor converts the vendored policy into config',
      result.ok === true && config !== null
        && JSON.stringify(config.protectedPaths) === '["spec/**","compose.y*ml","**/compose.y*ml","infra/**"]'
        && config.merge.loopLogin === 'loop-user' && config.merge.reversiblePaths === undefined
        && config.review.checklistPath === 'docs/agentic/checklist.md' && result.fingerprintChanged === true);
    const settings = JSON.parse(readIfPresent(join(repo, '.claude/settings.json')) ?? 'null');
    check('devendor leaves only the repository\'s own settings and hooks',
      !existsSync(join(repo, VENDORED_TOOLS)) && !existsSync(join(repo, 'docs/agentic/LOOP.md'))
        && !existsSync(join(repo, LEGACY_STATE_FILE)) && !existsSync(join(repo, '.claude/settings.local.json'))
        && JSON.stringify(settings) === JSON.stringify({
          permissions: { allow: ['Bash(npm test)'] },
          hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-hook' }] }] },
        }));
    const prose = readIfPresent(join(repo, '.autoloop', 'STATE.md')) ?? '';
    check('the STATE prose moves without its config block',
      prose.includes('Keep the engine honest.') && prose.includes('## Protected ground') && !prose.includes('autoloop-config'));
    check('ARCH and the checklist stay where the repository keeps them',
      existsSync(join(repo, 'docs/agentic/ARCH.md')) && existsSync(join(repo, 'docs/agentic/checklist.md')));
    const executorSettings = settingsFromConfig(config, { owner: 'acme', name: 'app' });
    check('the result is a devendored repository the plugin hooks, doctor, escalation and executor accept',
      activeAutoloopRoot(repo) === repo && doctor(repo).status === 0
        && matchEscalate(['spec/rules.md', 'deploy/compose.yml'], escalatePathsFor(repo).paths).length === 2
        && executorSettings.error === null && executorSettings.AUTOMERGE_MODE === 'all-green'
        && executorSettings.SOLO_OPERATOR === true);
    check('devendor runs once', devendor(repo, { projectDir: '' }).code === 'ALREADY_DEVENDORED');

    const manual = join(scratch, 'manual');
    legacyInstall(manual, {
      executor: false, config: { ...legacyConfig, merge: { policy: 'manual' } },
    });
    rmSync(join(manual, `${VENDORED_TOOLS}/escalate-paths.mjs`));
    const manualResult = devendor(manual, { projectDir: '' });
    check('a manual install with no repository entries keeps its config exactly',
      manualResult.ok === true && manualResult.fingerprintChanged === false
        && manualResult.config.protectedPaths === undefined && manualResult.config.merge.loopLogin === undefined);

    const broken = join(scratch, 'broken');
    legacyInstall(broken);
    write(broken, '.claude/settings.json', '{ not json');
    check('unreadable settings refuse before anything is written',
      devendor(broken, { projectDir: '' }).code === 'SETTINGS_UNREADABLE'
        && existsSync(join(broken, VENDORED_TOOLS)) && !existsSync(join(broken, PROJECT_CONFIG_FILE)));
    check('a repository with no legacy block is not devendored', devendor(join(scratch, 'none'), { projectDir: '' }).code === 'NOT_LEGACY');

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
        && init(broken, { base: 'main', gate: 'x' }).code === 'LEGACY_INSTALL');
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
  if (args.includes('--devendor') && root) result = devendor(resolve(root));
  else if (args.includes('--init') && root && flag(args, '--base') && flag(args, '--gate')) {
    result = init(resolve(root), { base: flag(args, '--base'), gate: flag(args, '--gate') });
  } else {
    console.error('usage: setup.mjs --init --root <repo> --base <branch> --gate <command> | --devendor --root <worktree> | --self-test');
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
