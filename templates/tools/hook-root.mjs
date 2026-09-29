#!/usr/bin/env node
// autoloop — hook-root.mjs
//
// Where a plugin hook acts, and whether it acts at all. Hooks ship in the
// plugin (hooks/hooks.json) and fire in every repository the user opens, so
// each one finds the project from CLAUDE_PROJECT_DIR — never from its own
// location, which is the plugin directory — and stands down unless the
// project is a devendored autoloop repository:
//
//   - `.autoloop/config.json` is present (or unreadable: the resolver then
//     refuses, which is the fail-closed outcome), and
//   - no vendored guard is wired in `.claude/settings.json`. A legacy
//     repository keeps its vendored hooks until devendor; a second, newer
//     guard beside them would judge the old layout.
//
//   node <plugin-tools>/hook-root.mjs --self-test

import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_CONFIG_FILE } from './config-contract.mjs';

const VENDORED_GUARD = 'tools/agentic/command-guard.mjs';
const SETTINGS_FILES = ['.claude/settings.json', '.claude/settings.local.json'];

export function hookRoot(env = process.env, cwd = process.cwd()) {
  if (typeof env.CLAUDE_PROJECT_DIR === 'string' && env.CLAUDE_PROJECT_DIR !== '') {
    return resolve(env.CLAUDE_PROJECT_DIR);
  }
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 20000 });
  return top.status === 0 ? top.stdout.trim() : resolve(cwd);
}

// Only a missing file is absent (the resolver's rule): an inaccessible
// `.autoloop/` keeps the hooks active so the guard refuses rather than sleeps.
function configPresent(root) {
  try {
    lstatSync(join(root, PROJECT_CONFIG_FILE));
    return true;
  } catch (error) {
    return error?.code !== 'ENOENT';
  }
}

// A settings file that cannot be read is not a wired guard: two guards are
// safer than none.
function vendoredGuardWired(root) {
  return SETTINGS_FILES.some((file) => {
    try {
      return readFileSync(join(root, file), 'utf8').includes(VENDORED_GUARD);
    } catch {
      return false;
    }
  });
}

export function activeAutoloopRoot(root = hookRoot()) {
  return configPresent(root) && !vendoredGuardWired(root) ? root : null;
}

function selfTest() {
  const failures = [];
  const cases = [];
  const check = (name, passed) => {
    cases.push(name);
    if (!passed) failures.push(name);
  };
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'hook-root-')));
  try {
    const repo = join(scratch, 'repo');
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
    spawnSync('git', ['init', '-q', repo]);
    check('CLAUDE_PROJECT_DIR is the root, whatever the cwd',
      hookRoot({ CLAUDE_PROJECT_DIR: repo }, join(repo, 'src', 'deep')) === repo);
    check('without CLAUDE_PROJECT_DIR, a subdirectory cwd resolves to the git top level',
      hookRoot({}, join(repo, 'src', 'deep')) === repo);
    check('an unrelated repository is inactive', activeAutoloopRoot(repo) === null);
    mkdirSync(join(repo, '.autoloop'));
    writeFileSync(join(repo, '.autoloop', 'config.json'), '{}');
    check('a devendored autoloop repository is active', activeAutoloopRoot(repo) === repo);
    mkdirSync(join(repo, '.claude'));
    writeFileSync(join(repo, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: `node "$CLAUDE_PROJECT_DIR/${VENDORED_GUARD}"` }] }] } }));
    check('a repository whose vendored guard is still wired is inactive', activeAutoloopRoot(repo) === null);
    writeFileSync(join(repo, '.claude', 'settings.json'), '{"hooks":{}}');
    mkdirSync(join(repo, 'tools', 'agentic'), { recursive: true });
    writeFileSync(join(repo, 'tools', 'agentic', 'command-guard.mjs'), '// leftover');
    check('a leftover vendored file without its wiring leaves the plugin guard active',
      activeAutoloopRoot(repo) === repo);
    rmSync(join(repo, '.autoloop'), { recursive: true, force: true });
    writeFileSync(join(repo, '.autoloop'), 'not a directory');
    check('an inaccessible config path keeps the hooks active (the resolver refuses)',
      activeAutoloopRoot(repo) === repo);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  for (const name of failures) console.error(`FAIL ${name}`);
  console.log(failures.length === 0
    ? `self-test OK (${cases.length} cases)`
    : `self-test FAILED (${failures.length}/${cases.length})`);
  return failures.length === 0;
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
  if (process.argv.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  console.error('usage: hook-root.mjs --self-test');
  process.exit(2);
}
