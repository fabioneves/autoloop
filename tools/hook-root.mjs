#!/usr/bin/env node
// autoloop — hook-root.mjs
//
// Where a plugin hook acts, and whether it acts at all. Hooks ship in the
// plugin (hooks/hooks.json) and fire in every repository the user opens, so
// each one finds the project from CLAUDE_PROJECT_DIR — never from its own
// location, which is the plugin directory — and stands down unless the
// project is a devendored autoloop repository:
//
//   `.autoloop/config.json` is present (or unreadable: the resolver then
//   refuses, which is the fail-closed outcome). A legacy repository has none,
//   so its vendored hooks run alone until devendor.
//
// This decides only whether a hook acts OUTSIDE an open run. Once prime opened
// a run (it refuses unless this repository is active), the guards act for the
// rest of the run whatever the checkout later says: a deleted config or a
// checked-out pre-devendor branch must not switch them off.
//
//   node <plugin-tools>/hook-root.mjs --self-test

import { spawnSync } from 'node:child_process';
import {
  lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_CONFIG_FILE, repositoryRoot } from './config-contract.mjs';
import { pluginRunBase } from './run-markers.mjs';

const VENDORED_DIR = 'tools/agentic';

// Every file the plugin ever vendored into tools/agentic/: each name ever under
// templates/tools (now tools) in this repository's history, plus the executor's installed
// name. A repository's own files there (a gate script) are not in it, and
// nothing outside it is ever treated as the tool's.
export const VENDORED_TOOL_NAMES = Object.freeze([
  'adapter-contract.mjs',
  'api-shape.mjs',
  'attestation-contract.mjs',
  'auto-merge.mjs',
  'auto-merge.reference.mjs',
  'briefs/code-review.md',
  'briefs/diff-review.md',
  'briefs/doubt-review.md',
  'briefs/fix.md',
  'briefs/implement.md',
  'briefs/plan-review.md',
  'briefs/plan.md',
  'briefs/simplify.md',
  'checkout-contract.mjs',
  'claim-contract.mjs',
  'command-guard.mjs',
  'config-contract.mjs',
  'continuation-store.mjs',
  'contract-lint.mjs',
  'delivery-contract.mjs',
  'dispatch-render.mjs',
  'dispatch-stream.sh',
  'dispatch.mjs',
  'edit-guard.mjs',
  'escalate-paths.mjs',
  'guard-corpus.json',
  'hook-relay.mjs',
  'hook-root.mjs',
  'intent-contract.mjs',
  'label-swap-reminder.mjs',
  'lane-contract.mjs',
  'lifecycle-contract.mjs',
  'lifecycle-driver.mjs',
  'loop-scope.mjs',
  'loop-smoke.mjs',
  'measurement-contract.mjs',
  'merge-authorization-contract.mjs',
  'overlap-report.mjs',
  'prime.mjs',
  'publish-verdict.mjs',
  'regression-index.mjs',
  'release-verify.mjs',
  'review-contract.mjs',
  'route-adapter-contract.mjs',
  'run-scope.mjs',
  'runtime-contract.mjs',
  'scaffold.mjs',
  'scan.mjs',
  'self-test-manifest.json',
  'session-preflight.sh',
  'setup.mjs',
  'sizing-contract.mjs',
  'snapshot-contract.mjs',
  'stats.mjs',
  'step-subject.mjs',
  'step.mjs',
  'subagent-transcript.mjs',
  'unit.mjs',
  'verify.mjs',
  'writeback-check.mjs',
]);

// A hook command that runs a vendored tool.
export function runsVendoredTool(command) {
  const text = String(command ?? '');
  return VENDORED_TOOL_NAMES.some((name) => text.includes(`${VENDORED_DIR}/${name}`));
}

function hookCommands(root, file) {
  let document;
  try {
    document = JSON.parse(readFileSync(join(root, file), 'utf8'));
  } catch {
    return [];
  }
  return Object.values(document?.hooks ?? {}).flatMap((groups) => (Array.isArray(groups) ? groups : [])
    .flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : []))
    .map((handler) => String(handler?.command ?? '')));
}

function filesUnder(directory, prefix = '') {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => (entry.isDirectory()
    ? filesUnder(join(directory, entry.name), `${prefix}${entry.name}/`)
    : [`${prefix}${entry.name}`]));
}

// What of the vendored layout is still in a repository: shipped files under
// tools/agentic/ and hook commands running them, in either settings file.
export function vendoredLeftovers(root) {
  return {
    files: filesUnder(join(root, VENDORED_DIR)).filter((name) => VENDORED_TOOL_NAMES.includes(name)),
    hooks: ['.claude/settings.json', '.claude/settings.local.json'].flatMap((file) =>
      hookCommands(root, file).filter(runsVendoredTool).map((command) => ({ file, command }))),
  };
}

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

export function activeAutoloopRoot(root = hookRoot()) {
  return configPresent(root) ? root : null;
}

// Where a plugin hook acts: the devendored autoloop repository at the project
// root, or — while a plugin run is open — that root whatever the checkout now
// says, so no file the run can change switches the hooks off mid-run.
export function guardedRoot(projectRoot = hookRoot()) {
  return activeAutoloopRoot(projectRoot)
    ?? (pluginRunBase([process.cwd(), projectRoot]) === null ? null : projectRoot);
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
    // The one definition of what is left of the vendored layout: shipped
    // files and hooks running them — never a repository's own gate script.
    mkdirSync(join(repo, 'tools', 'agentic', 'briefs'), { recursive: true });
    writeFileSync(join(repo, 'tools', 'agentic', 'gate.mjs'), '// the repository\'s own\n');
    writeFileSync(join(repo, 'tools', 'agentic', 'briefs', 'plan.md'), '# plan\n');
    writeFileSync(join(repo, '.claude', 'settings.local.json'), JSON.stringify({
      permissions: { allow: ['Bash(node tools/agentic/prime.mjs --json)'] },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node tools/agentic/writeback-check.mjs' },
        { type: 'command', command: 'node tools/agentic/gate.mjs' }] }] },
    }));
    const leftovers = vendoredLeftovers(repo);
    check('vendored leftovers are the shipped files and the hooks that run them, nothing of the repository\'s own',
      JSON.stringify(leftovers.files) === '["briefs/plan.md"]'
        && JSON.stringify(leftovers.hooks.map(({ command }) => command)) === '["node tools/agentic/writeback-check.mjs"]');
    rmSync(join(repo, 'tools'), { recursive: true, force: true });
    rmSync(join(repo, '.claude', 'settings.local.json'));
    // The shell hooks ask the same question (plus the open-run rule) through the CLI.
    const cli = (dir) => spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--guarded-root'], {
      encoding: 'utf8', cwd: tmpdir(), env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    });
    const activeCli = cli(repo);
    const inactiveCli = cli(scratch);
    check('--guarded-root prints an active root and exits 0, else exits 1 silently',
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
  // For the shell hooks (session-preflight): the root a hook acts in, or exit 1.
  if (process.argv.includes('--guarded-root')) {
    const root = guardedRoot();
    if (root !== null) console.log(root);
    process.exit(root === null ? 1 : 0);
  }
  console.error('usage: hook-root.mjs --guarded-root | --self-test');
  process.exit(2);
}
