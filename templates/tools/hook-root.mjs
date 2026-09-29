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
// This decides only whether a hook acts OUTSIDE an open run. Once prime opened
// a run (it refuses unless this repository is active), the guards act for the
// rest of the run whatever the checkout later says: a deleted config or a
// checked-out pre-devendor branch must not switch them off.
//
//   node <plugin-tools>/hook-root.mjs --active     (shell hooks: root, or exit 1)
//   node <plugin-tools>/hook-root.mjs --self-test

import { spawnSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_CONFIG_FILE, repositoryRoot } from './config-contract.mjs';

const VENDORED_GUARD = 'tools/agentic/command-guard.mjs';

export function hookRoot(env = process.env, cwd = process.cwd()) {
  return repositoryRoot(typeof env.CLAUDE_PROJECT_DIR === 'string' && env.CLAUDE_PROJECT_DIR !== ''
    ? resolve(env.CLAUDE_PROJECT_DIR)
    : cwd);
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

// A legacy install's wiring: a hook command in the tracked settings running a
// vendored guard that still exists. Nothing weaker counts — a permission entry,
// an untracked local settings file or unreadable settings leave the plugin
// guard on, since two guards are safer than none.
function vendoredGuardWired(root) {
  if (!existsSync(join(root, VENDORED_GUARD))) return false;
  let document;
  try {
    document = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'));
  } catch {
    return false;
  }
  return Object.values(document?.hooks ?? {}).some((groups) => (Array.isArray(groups) ? groups : [])
    .some((group) => (Array.isArray(group?.hooks) ? group.hooks : [])
      .some((handler) => String(handler?.command ?? '').includes(VENDORED_GUARD))));
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
    // A session started in a subdirectory still guards the repository prime
    // opened its run in.
    check('CLAUDE_PROJECT_DIR in a subdirectory resolves to its git top level',
      hookRoot({ CLAUDE_PROJECT_DIR: join(repo, 'src', 'deep') }, scratch) === repo);
    check('without CLAUDE_PROJECT_DIR, a subdirectory cwd resolves to the git top level',
      hookRoot({}, join(repo, 'src', 'deep')) === repo);
    check('an unrelated repository is inactive', activeAutoloopRoot(repo) === null);
    mkdirSync(join(repo, '.autoloop'));
    writeFileSync(join(repo, '.autoloop', 'config.json'), '{}');
    check('a devendored autoloop repository is active', activeAutoloopRoot(repo) === repo);
    mkdirSync(join(repo, '.claude'));
    mkdirSync(join(repo, 'tools', 'agentic'), { recursive: true });
    writeFileSync(join(repo, 'tools', 'agentic', 'command-guard.mjs'), '// vendored');
    const wiring = { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: `node "$CLAUDE_PROJECT_DIR/${VENDORED_GUARD}"` }] }] } };
    writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify(wiring));
    check('a repository whose vendored guard is still wired is inactive', activeAutoloopRoot(repo) === null);
    // Only a real hook in the tracked settings, running a guard that exists,
    // counts: a stray string (a permission entry, a local settings file, a
    // symlink to notes) must not switch the plugin guard off.
    writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: [`Bash(node ${VENDORED_GUARD} --self-test)`] } }));
    writeFileSync(join(repo, '.claude', 'settings.local.json'), JSON.stringify(wiring));
    check('a permission entry or local settings naming the vendored guard leave the plugin guard active',
      activeAutoloopRoot(repo) === repo);
    writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify(wiring));
    rmSync(join(repo, 'tools'), { recursive: true, force: true });
    check('wiring whose vendored guard file is gone leaves the plugin guard active',
      activeAutoloopRoot(repo) === repo);
    writeFileSync(join(repo, '.claude', 'settings.json'), '{"hooks":{}}');
    rmSync(join(repo, '.claude', 'settings.local.json'));
    // The shell hooks ask the same question through the CLI.
    const cli = (dir) => spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--active'], {
      encoding: 'utf8', cwd: tmpdir(), env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    });
    const activeCli = cli(repo);
    const inactiveCli = cli(scratch);
    check('--active prints an active root and exits 0, else exits 1 silently',
      activeCli.status === 0 && activeCli.stdout.trim() === repo
        && inactiveCli.status === 1 && inactiveCli.stdout === '');
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
  // For the shell hooks: prints the active root and exits 0, else exits 1.
  if (process.argv.includes('--active')) {
    const root = activeAutoloopRoot();
    if (root !== null) console.log(root);
    process.exit(root === null ? 1 : 0);
  }
  console.error('usage: hook-root.mjs --active | --self-test');
  process.exit(2);
}
